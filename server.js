const http = require('node:http');
const { createClient } = require('@libsql/client');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 8080;
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}
const DB_FILE = path.join(DB_DIR, 'manmeet_cloud.db');
const DATABASE_URL = process.env.DATABASE_URL || `file:${DB_FILE}`;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN || undefined;

const client = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN
});

const db = {
  async get(sql, ...args) {
    const rs = await client.execute({ sql, args });
    return rs.rows[0] || null;
  },
  async all(sql, ...args) {
    const rs = await client.execute({ sql, args });
    return rs.rows;
  },
  async run(sql, ...args) {
    return await client.execute({ sql, args });
  },
  async exec(sql) {
    return await client.executeMultiple(sql);
  }
};

// Initialize schema asynchronously
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      destination TEXT UNIQUE,
      isEmail INTEGER,
      accountType TEXT,
      authToken TEXT UNIQUE,
      createdAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS profiles (
      userId TEXT PRIMARY KEY,
      fullName TEXT,
      age INTEGER,
      gender TEXT,
      interestedIn TEXT,
      city TEXT,
      country TEXT,
      occupation TEXT,
      relationshipIntention TEXT,
      bio TEXT,
      interestsJson TEXT,
      photoUrisJson TEXT,
      isVerified INTEGER,
      updatedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS likes (
      callerUserId TEXT,
      targetCandidateId TEXT,
      note TEXT,
      accountType TEXT,
      createdAt INTEGER,
      PRIMARY KEY (callerUserId, targetCandidateId)
    );

    CREATE TABLE IF NOT EXISTS passes (
      callerUserId TEXT,
      targetCandidateId TEXT,
      accountType TEXT,
      createdAt INTEGER,
      PRIMARY KEY (callerUserId, targetCandidateId)
    );

    CREATE TABLE IF NOT EXISTS matches (
      matchId TEXT PRIMARY KEY,
      user1Id TEXT,
      user2Id TEXT,
      matchedAt INTEGER,
      initialNote TEXT,
      lastMessagePreview TEXT,
      lastMessageTime INTEGER,
      conversationId TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS messages (
      messageId TEXT PRIMARY KEY,
      conversationId TEXT,
      senderId TEXT,
      receiverId TEXT,
      text TEXT,
      timestamp INTEGER,
      deliveryStatus TEXT,
      isRead INTEGER
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      createdAt INTEGER
    );
  `);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(body));
}

function parseAuthToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

async function authenticate(req) {
  const token = parseAuthToken(req);
  if (!token) return null;
  const user = await db.get('SELECT * FROM users WHERE authToken = ?', token);
  return user || null;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Safe logging (no PII, no tokens)
  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Health check
  if (pathname === '/health' || pathname === '/api/health') {
    return sendJson(res, 200, {
      status: 'healthy',
      service: 'manmeet-authoritative-cloud',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: Date.now()
    });
  }

  // Read request body for POST / PUT
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const data = Buffer.concat(buffers).toString();
      if (data) {
        body = JSON.parse(data);
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: 'Invalid JSON payload' });
    }
  }

  try {
    // 1. REGISTER OR LOGIN
    if (pathname === '/api/auth/register-or-login' && method === 'POST') {
      const { destination, isEmail = true, accountType = 'REAL' } = body;
      if (!destination) {
        return sendJson(res, 400, { success: false, error: 'destination required' });
      }

      const existingUser = await db.get('SELECT * FROM users WHERE destination = ?', destination);
      if (existingUser) {
        // Return existing session or refresh token
        const newAuthToken = `manmeet_bearer_${existingUser.userId}_${crypto.randomBytes(8).toString('hex')}`;
        await db.run('UPDATE users SET authToken = ? WHERE userId = ?', newAuthToken, existingUser.userId);
        return sendJson(res, 200, {
          success: true,
          data: {
            userId: existingUser.userId,
            destination: existingUser.destination,
            isEmail: Boolean(existingUser.isEmail),
            accountType: existingUser.accountType,
            authToken: newAuthToken,
            createdAt: existingUser.createdAt
          }
        });
      }

      const userId = `usr_${crypto.randomBytes(6).toString('hex')}`;
      const authToken = `manmeet_bearer_${userId}_${crypto.randomBytes(8).toString('hex')}`;
      const now = Date.now();

      await db.run(`
        INSERT INTO users (userId, destination, isEmail, accountType, authToken, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `, userId, destination, isEmail ? 1 : 0, accountType, authToken, now);

      // Create initial profile
      const defaultName = isEmail ? destination.split('@')[0] : 'User';
      await db.run(`
        INSERT INTO profiles (userId, fullName, age, gender, interestedIn, city, country, occupation, relationshipIntention, bio, interestsJson, photoUrisJson, isVerified, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, userId, defaultName, 26, 'Woman', 'Men', 'Mumbai', 'India', 'Professional', 'MEANINGFUL_DATING', 'Looking for a genuine connection', '[]', '[]', 1, now);

      return sendJson(res, 200, {
        success: true,
        data: {
          userId,
          destination,
          isEmail: Boolean(isEmail),
          accountType,
          authToken,
          createdAt: now
        }
      });
    }

    // AUTHENTICATION CHECK FOR PROTECTED ROUTES
    const authUser = await authenticate(req);

    // 2. LOGOUT
    if (pathname === '/api/auth/logout' && method === 'POST') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      await db.run('UPDATE users SET authToken = NULL WHERE userId = ?', authUser.userId);
      return sendJson(res, 200, { success: true, data: null });
    }

    // 3. GET PROFILE
    if (pathname.startsWith('/api/profile/') && method === 'GET') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const targetUserId = pathname.replace('/api/profile/', '').trim();
      const profile = await db.get('SELECT * FROM profiles WHERE userId = ?', targetUserId);
      if (!profile) return sendJson(res, 404, { success: false, error: 'Profile not found' });
      return sendJson(res, 200, {
        success: true,
        data: {
          userId: profile.userId,
          fullName: profile.fullName,
          age: profile.age,
          gender: profile.gender,
          interestedIn: profile.interestedIn,
          city: profile.city,
          country: profile.country,
          occupation: profile.occupation,
          relationshipIntention: profile.relationshipIntention,
          bio: profile.bio,
          interests: JSON.parse(profile.interestsJson || '[]'),
          photoUris: JSON.parse(profile.photoUrisJson || '[]'),
          isVerified: Boolean(profile.isVerified),
          updatedAt: profile.updatedAt
        }
      });
    }

    // 4. UPDATE PROFILE
    if (pathname === '/api/profile' && method === 'PUT') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      if (body.userId && body.userId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Cannot edit another user profile' });
      }
      const now = Date.now();
      await db.run(`
        INSERT INTO profiles (userId, fullName, age, gender, interestedIn, city, country, occupation, relationshipIntention, bio, interestsJson, photoUrisJson, isVerified, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
          fullName = excluded.fullName,
          age = excluded.age,
          gender = excluded.gender,
          interestedIn = excluded.interestedIn,
          city = excluded.city,
          country = excluded.country,
          occupation = excluded.occupation,
          relationshipIntention = excluded.relationshipIntention,
          bio = excluded.bio,
          interestsJson = excluded.interestsJson,
          photoUrisJson = excluded.photoUrisJson,
          isVerified = excluded.isVerified,
          updatedAt = excluded.updatedAt
      `,
        authUser.userId,
        body.fullName || 'User',
        body.age || 25,
        body.gender || 'Woman',
        body.interestedIn || 'Men',
        body.city || 'Mumbai',
        body.country || 'India',
        body.occupation || 'Engineer',
        body.relationshipIntention || 'MEANINGFUL_DATING',
        body.bio || '',
        JSON.stringify(body.interests || []),
        JSON.stringify(body.photoUris || []),
        body.isVerified ? 1 : 0,
        now
      );
      return sendJson(res, 200, { success: true, data: { ...body, userId: authUser.userId, updatedAt: now } });
    }

    // 5. SUBMIT LIKE & MUTUAL MATCHING
    if (pathname === '/api/matches/like' && method === 'POST') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const { callerUserId, targetCandidateId, note = null, idempotencyKey } = body;
      if (callerUserId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Caller ID mismatch' });
      }

      // Check idempotency
      if (idempotencyKey) {
        const existingKey = await db.get('SELECT key FROM idempotency_keys WHERE key = ?', idempotencyKey);
        if (existingKey) {
          // Already processed, return current match if exists
          const existingMatch = await db.get('SELECT * FROM matches WHERE (user1Id = ? AND user2Id = ?) OR (user1Id = ? AND user2Id = ?)', callerUserId, targetCandidateId, targetCandidateId, callerUserId);
          if (existingMatch) {
            return sendJson(res, 200, { success: true, data: { type: 'MUTUAL_MATCH', match: existingMatch } });
          }
          return sendJson(res, 200, { success: true, data: { type: 'LIKE_REGISTERED' } });
        }
        await db.run('INSERT INTO idempotency_keys (key, createdAt) VALUES (?, ?)', idempotencyKey, Date.now());
      }

      // Remove pass if any
      await db.run('DELETE FROM passes WHERE callerUserId = ? AND targetCandidateId = ?', callerUserId, targetCandidateId);

      // Record like
      const now = Date.now();
      await db.run(`
        INSERT INTO likes (callerUserId, targetCandidateId, note, accountType, createdAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(callerUserId, targetCandidateId) DO UPDATE SET note = excluded.note, createdAt = excluded.createdAt
      `, callerUserId, targetCandidateId, note, authUser.accountType, now);

      // Check if targetCandidate has liked caller (Reciprocal Mutual Match)
      const reciprocalLike = await db.get('SELECT * FROM likes WHERE callerUserId = ? AND targetCandidateId = ?', targetCandidateId, callerUserId);
      if (reciprocalLike) {
        // Mutual match formed!
        const matchId = `match_${Math.min(callerUserId.localeCompare(targetCandidateId), 1) < 0 ? callerUserId + '_' + targetCandidateId : targetCandidateId + '_' + callerUserId}`;
        const conversationId = `conv_${matchId}`;
        const initialNote = reciprocalLike.note || note || null;

        await db.run(`
          INSERT INTO matches (matchId, user1Id, user2Id, matchedAt, initialNote, lastMessagePreview, lastMessageTime, conversationId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(matchId) DO UPDATE SET lastMessageTime = excluded.lastMessageTime
        `, matchId, callerUserId, targetCandidateId, now, initialNote, initialNote, now, conversationId);

        if (initialNote) {
          const msgId = `msg_note_${now}`;
          await db.run(`
            INSERT INTO messages (messageId, conversationId, senderId, receiverId, text, timestamp, deliveryStatus, isRead)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(messageId) DO NOTHING
          `, msgId, conversationId, reciprocalLike.note ? targetCandidateId : callerUserId, reciprocalLike.note ? callerUserId : targetCandidateId, initialNote, now, 'SENT', 0);
        }

        const matchRecord = await db.get('SELECT * FROM matches WHERE matchId = ?', matchId);
        return sendJson(res, 200, {
          success: true,
          data: {
            type: 'MUTUAL_MATCH',
            match: matchRecord
          }
        });
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          type: 'LIKE_REGISTERED'
        }
      });
    }

    // 6. SUBMIT PASS
    if (pathname === '/api/matches/pass' && method === 'POST') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const { callerUserId, targetCandidateId, idempotencyKey } = body;
      if (callerUserId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Caller ID mismatch' });
      }

      if (idempotencyKey) {
        await db.run('INSERT OR IGNORE INTO idempotency_keys (key, createdAt) VALUES (?, ?)', idempotencyKey, Date.now());
      }

      await db.run('DELETE FROM likes WHERE callerUserId = ? AND targetCandidateId = ?', callerUserId, targetCandidateId);
      await db.run(`
        INSERT INTO passes (callerUserId, targetCandidateId, accountType, createdAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(callerUserId, targetCandidateId) DO NOTHING
      `, callerUserId, targetCandidateId, authUser.accountType, Date.now());

      return sendJson(res, 200, { success: true, data: null });
    }

    // 7. GET MATCHES
    if (pathname.startsWith('/api/matches/') && method === 'GET') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const userId = pathname.replace('/api/matches/', '').trim();
      if (userId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden' });
      }
      const matches = await db.all('SELECT * FROM matches WHERE user1Id = ? OR user2Id = ? ORDER BY lastMessageTime DESC', userId, userId);
      return sendJson(res, 200, { success: true, data: matches });
    }

    // 8. GET CHAT MESSAGES
    if (pathname === '/api/chat/messages' && method === 'GET') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const conversationId = parsedUrl.searchParams.get('conversationId');
      const callerUserId = parsedUrl.searchParams.get('callerUserId');

      if (!conversationId || !callerUserId) {
        return sendJson(res, 400, { success: false, error: 'conversationId and callerUserId required' });
      }
      if (callerUserId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden' });
      }

      // Authorization check: User must be a participant
      const match = await db.get('SELECT * FROM matches WHERE conversationId = ?', conversationId);
      if (match && match.user1Id !== callerUserId && match.user2Id !== callerUserId) {
        return sendJson(res, 403, { success: false, error: 'Unauthorized participant' });
      }

      const messages = await db.all('SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC', conversationId);
      return sendJson(res, 200, { success: true, data: messages });
    }

    // 9. SEND CHAT MESSAGE
    if (pathname === '/api/chat/messages' && method === 'POST') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const { messageId, conversationId, senderId, receiverId, text, timestamp = Date.now() } = body;
      if (senderId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Sender ID mismatch' });
      }

      const msgId = messageId || `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      await db.run(`
        INSERT INTO messages (messageId, conversationId, senderId, receiverId, text, timestamp, deliveryStatus, isRead)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, msgId, conversationId, senderId, receiverId, text, timestamp, 'DELIVERED', 0);

      // Update match preview
      await db.run('UPDATE matches SET lastMessagePreview = ?, lastMessageTime = ? WHERE conversationId = ?', text, timestamp, conversationId);

      return sendJson(res, 200, {
        success: true,
        data: {
          messageId: msgId,
          conversationId,
          senderId,
          receiverId,
          text,
          timestamp,
          deliveryStatus: 'DELIVERED',
          isRead: false
        }
      });
    }

    // 10. UNMATCH
    if (pathname === '/api/matches/unmatch' && method === 'POST') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const { callerUserId, targetCandidateId } = body;
      if (callerUserId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden' });
      }

      await db.run('DELETE FROM likes WHERE (callerUserId = ? AND targetCandidateId = ?) OR (callerUserId = ? AND targetCandidateId = ?)', callerUserId, targetCandidateId, targetCandidateId, callerUserId);
      await db.run('DELETE FROM matches WHERE (user1Id = ? AND user2Id = ?) OR (user1Id = ? AND user2Id = ?)', callerUserId, targetCandidateId, targetCandidateId, callerUserId);

      return sendJson(res, 200, { success: true, data: true });
    }

    // 11. DELETE ACCOUNT
    if (pathname.startsWith('/api/account/') && method === 'DELETE') {
      if (!authUser) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
      const userId = pathname.replace('/api/account/', '').trim();
      if (userId !== authUser.userId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Cannot delete other user account' });
      }

      await db.run('DELETE FROM likes WHERE callerUserId = ? OR targetCandidateId = ?', userId, userId);
      await db.run('DELETE FROM passes WHERE callerUserId = ? OR targetCandidateId = ?', userId, userId);
      await db.run('DELETE FROM matches WHERE user1Id = ? OR user2Id = ?', userId, userId);
      await db.run('DELETE FROM messages WHERE senderId = ? OR receiverId = ?', userId, userId);
      await db.run('DELETE FROM profiles WHERE userId = ?', userId);
      await db.run('DELETE FROM users WHERE userId = ?', userId);

      return sendJson(res, 200, { success: true, data: true });
    }

    // 404 Not Found
    return sendJson(res, 404, { success: false, error: 'Endpoint not found' });
  } catch (err) {
    console.error('Server error:', err.message);
    return sendJson(res, 500, { success: false, error: 'Internal server error' });
  }
});

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MANMEET Authoritative Cloud Server listening on http://0.0.0.0:${PORT}`);
    console.log(`Database URL: ${DATABASE_URL.startsWith('libsql') ? 'Turso Cloud' : DB_FILE}`);
  });
}).catch(err => {
  console.error('Failed to initialize database schema:', err);
  process.exit(1);
});
