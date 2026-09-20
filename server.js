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

// Resolve database URL and auth token from environment variables (supporting common aliases and trimming quotes/spaces)
function resolveDatabaseConfig() {
  const envUrl = (
    process.env.DATABASE_URL ||
    process.env.TURSO_DATABASE_URL ||
    process.env.LIBSQL_DATABASE_URL ||
    process.env.TURSO_URL ||
    process.env.LIBSQL_URL ||
    ''
  ).trim().replace(/^["']|["']$/g, '').trim();

  const envToken = (
    process.env.DATABASE_AUTH_TOKEN ||
    process.env.TURSO_AUTH_TOKEN ||
    process.env.LIBSQL_AUTH_TOKEN ||
    process.env.TURSO_TOKEN ||
    process.env.LIBSQL_TOKEN ||
    ''
  ).trim().replace(/^["']|["']$/g, '').trim();

  if (envUrl) {
    let normalizedUrl = envUrl;
    if (!normalizedUrl.includes('://') && normalizedUrl.includes('.turso.io')) {
      normalizedUrl = `libsql://${normalizedUrl}`;
    }

    const isTurso = normalizedUrl.startsWith('libsql://') ||
                    normalizedUrl.startsWith('https://') ||
                    normalizedUrl.startsWith('http://') ||
                    normalizedUrl.includes('.turso.io');

    return {
      isRemote: true,
      isTurso,
      url: normalizedUrl,
      authToken: envToken || undefined
    };
  }

  return {
    isRemote: false,
    isTurso: false,
    url: `file:${DB_FILE}`,
    authToken: undefined
  };
}

const dbConfig = resolveDatabaseConfig();

const client = createClient({
  url: dbConfig.url,
  authToken: dbConfig.authToken
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
      photosJson TEXT,
      promptAnswersJson TEXT,
      interestsJson TEXT,
      community TEXT,
      religion TEXT,
      motherTongue TEXT,
      heightCm INTEGER,
      lifestyleAnswersJson TEXT,
      safetyFlagsJson TEXT,
      isProfileComplete INTEGER,
      updatedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS matches (
      matchId TEXT PRIMARY KEY,
      user1Id TEXT,
      user2Id TEXT,
      createdAt INTEGER,
      initiatorNote TEXT,
      isHeartfelt INTEGER DEFAULT 0,
      UNIQUE(user1Id, user2Id)
    );

    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      callerUserId TEXT,
      targetCandidateId TEXT,
      note TEXT,
      createdAt INTEGER,
      UNIQUE(callerUserId, targetCandidateId)
    );

    CREATE TABLE IF NOT EXISTS passes (
      id TEXT PRIMARY KEY,
      callerUserId TEXT,
      targetCandidateId TEXT,
      createdAt INTEGER,
      UNIQUE(callerUserId, targetCandidateId)
    );

    CREATE TABLE IF NOT EXISTS messages (
      messageId TEXT PRIMARY KEY,
      senderId TEXT,
      receiverId TEXT,
      content TEXT,
      timestamp INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(senderId, receiverId, timestamp);
    CREATE INDEX IF NOT EXISTS idx_matches_users ON matches(user1Id, user2Id);
    CREATE INDEX IF NOT EXISTS idx_likes_caller ON likes(callerUserId);
    CREATE INDEX IF NOT EXISTS idx_passes_caller ON passes(callerUserId);
  `);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function parseAuthHeader(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    return parts[1].trim();
  }
  return null;
}

function generateToken() {
  return 'mmt_' + crypto.randomBytes(24).toString('hex');
}

function generateUserId() {
  return 'usr_' + crypto.randomBytes(6).toString('hex');
}

function generateMatchId(u1, u2) {
  return [u1, u2].sort().join('_match_');
}

function generateId() {
  return 'id_' + crypto.randomBytes(8).toString('hex');
}

function safeJsonParse(str, defaultVal) {
  if (!str) return defaultVal;
  try {
    return JSON.parse(str);
  } catch (e) {
    return defaultVal;
  }
}

function formatProfileResponse(row) {
  if (!row) return null;
  return {
    userId: row.userId,
    fullName: row.fullName || '',
    age: Number(row.age) || 24,
    gender: row.gender || '',
    interestedIn: row.interestedIn || '',
    city: row.city || '',
    country: row.country || '',
    occupation: row.occupation || '',
    relationshipIntention: row.relationshipIntention || '',
    bio: row.bio || '',
    photos: safeJsonParse(row.photosJson, []),
    promptAnswers: safeJsonParse(row.promptAnswersJson, []),
    interests: safeJsonParse(row.interestsJson, []),
    community: row.community || null,
    religion: row.religion || null,
    motherTongue: row.motherTongue || null,
    heightCm: row.heightCm ? Number(row.heightCm) : null,
    lifestyleAnswers: safeJsonParse(row.lifestyleAnswersJson, {}),
    safetyFlags: safeJsonParse(row.safetyFlagsJson, []),
    isProfileComplete: Boolean(row.isProfileComplete)
  };
}

async function authenticate(req) {
  const token = parseAuthHeader(req);
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
      database: dbConfig.isRemote ? (dbConfig.isTurso ? 'Turso Cloud' : 'Remote libSQL') : 'Local SQLite',
      databaseUrl: dbConfig.isRemote ? dbConfig.url.replace(/:\/\/[^@]*@/, '://') : 'local-file',
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
    // 1. Auth: Register or Login
    if (pathname === '/api/auth/register-or-login' && method === 'POST') {
      const destination = (body.destination || '').trim();
      const isEmail = Boolean(body.isEmail);
      const accountType = body.accountType || 'DATING';

      if (!destination) {
        return sendJson(res, 400, { success: false, error: 'Destination is required' });
      }

      let existing = await db.get('SELECT * FROM users WHERE destination = ?', destination);
      let user;

      if (existing) {
        const token = generateToken();
        await db.run('UPDATE users SET authToken = ? WHERE userId = ?', token, existing.userId);
        user = await db.get('SELECT * FROM users WHERE userId = ?', existing.userId);
      } else {
        const newUserId = generateUserId();
        const token = generateToken();
        const now = Date.now();
        await db.run(
          'INSERT INTO users (userId, destination, isEmail, accountType, authToken, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
          newUserId, destination, isEmail ? 1 : 0, accountType, token, now
        );
        user = await db.get('SELECT * FROM users WHERE userId = ?', newUserId);
      }

      const prof = await db.get('SELECT * FROM profiles WHERE userId = ?', user.userId);
      const isComplete = prof ? Boolean(prof.isProfileComplete) : false;

      return sendJson(res, 200, {
        success: true,
        data: {
          token: user.authToken,
          userId: user.userId,
          isNewUser: !isComplete,
          profileComplete: isComplete
        }
      });
    }

    // Auth protected endpoints below
    const currentUser = await authenticate(req);
    if (!currentUser) {
      return sendJson(res, 401, { success: false, error: 'Unauthorized: Invalid or missing token' });
    }
    const currentUserId = currentUser.userId;

    // 2. Profile: Get Self or Target
    if (pathname.startsWith('/api/profile/') && method === 'GET') {
      const targetUserId = pathname.replace('/api/profile/', '').trim();
      if (!targetUserId) {
        return sendJson(res, 400, { success: false, error: 'User ID missing in path' });
      }

      const row = await db.get('SELECT * FROM profiles WHERE userId = ?', targetUserId);
      if (!row) {
        return sendJson(res, 404, { success: false, error: 'Profile not found' });
      }

      return sendJson(res, 200, {
        success: true,
        data: formatProfileResponse(row)
      });
    }

    // 3. Profile: Save / Upsert Profile
    if (pathname === '/api/profile' && method === 'POST') {
      const p = body;
      const targetUserId = (p.userId || currentUserId).trim();

      if (targetUserId !== currentUserId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Cannot edit another user profile' });
      }

      const photosJson = JSON.stringify(p.photos || []);
      const promptAnswersJson = JSON.stringify(p.promptAnswers || []);
      const interestsJson = JSON.stringify(p.interests || []);
      const lifestyleAnswersJson = JSON.stringify(p.lifestyleAnswers || {});
      const safetyFlagsJson = JSON.stringify(p.safetyFlags || []);
      const isComplete = p.isProfileComplete ? 1 : 0;
      const now = Date.now();

      await db.run(`
        INSERT INTO profiles (
          userId, fullName, age, gender, interestedIn, city, country, occupation,
          relationshipIntention, bio, photosJson, promptAnswersJson, interestsJson,
          community, religion, motherTongue, heightCm, lifestyleAnswersJson, safetyFlagsJson,
          isProfileComplete, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
          fullName=excluded.fullName,
          age=excluded.age,
          gender=excluded.gender,
          interestedIn=excluded.interestedIn,
          city=excluded.city,
          country=excluded.country,
          occupation=excluded.occupation,
          relationshipIntention=excluded.relationshipIntention,
          bio=excluded.bio,
          photosJson=excluded.photosJson,
          promptAnswersJson=excluded.promptAnswersJson,
          interestsJson=excluded.interestsJson,
          community=excluded.community,
          religion=excluded.religion,
          motherTongue=excluded.motherTongue,
          heightCm=excluded.heightCm,
          lifestyleAnswersJson=excluded.lifestyleAnswersJson,
          safetyFlagsJson=excluded.safetyFlagsJson,
          isProfileComplete=excluded.isProfileComplete,
          updatedAt=excluded.updatedAt
      `,
        targetUserId,
        p.fullName || '',
        Number(p.age) || 24,
        p.gender || '',
        p.interestedIn || '',
        p.city || '',
        p.country || '',
        p.occupation || '',
        p.relationshipIntention || '',
        p.bio || '',
        photosJson,
        promptAnswersJson,
        interestsJson,
        p.community || null,
        p.religion || null,
        p.motherTongue || null,
        p.heightCm ? Number(p.heightCm) : null,
        lifestyleAnswersJson,
        safetyFlagsJson,
        isComplete,
        now
      );

      const saved = await db.get('SELECT * FROM profiles WHERE userId = ?', targetUserId);
      return sendJson(res, 200, {
        success: true,
        data: formatProfileResponse(saved)
      });
    }

    // 4. Discovery Feed: Discover Candidates
    if (pathname === '/api/discovery/feed' && method === 'GET') {
      const candidates = await db.all(`
        SELECT p.* FROM profiles p
        WHERE p.userId != ?
          AND p.userId NOT IN (SELECT targetCandidateId FROM likes WHERE callerUserId = ?)
          AND p.userId NOT IN (SELECT targetCandidateId FROM passes WHERE callerUserId = ?)
        ORDER BY p.updatedAt DESC
        LIMIT 50
      `, currentUserId, currentUserId, currentUserId);

      const result = candidates.map(formatProfileResponse);
      return sendJson(res, 200, { success: true, data: result });
    }

    // 5. Matches: Like Candidate
    if (pathname === '/api/matches/like' && method === 'POST') {
      const callerUserId = (body.callerUserId || currentUserId).trim();
      const targetCandidateId = (body.targetCandidateId || '').trim();
      const note = (body.note || '').trim();

      if (callerUserId !== currentUserId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden' });
      }
      if (!targetCandidateId) {
        return sendJson(res, 400, { success: false, error: 'targetCandidateId required' });
      }

      const now = Date.now();
      await db.run(
        'INSERT OR REPLACE INTO likes (id, callerUserId, targetCandidateId, note, createdAt) VALUES (?, ?, ?, ?, ?)',
        generateId(), callerUserId, targetCandidateId, note, now
      );

      const reciprocal = await db.get(
        'SELECT * FROM likes WHERE callerUserId = ? AND targetCandidateId = ?',
        targetCandidateId, callerUserId
      );

      if (reciprocal) {
        const matchId = generateMatchId(callerUserId, targetCandidateId);
        const hasNote = Boolean(note || reciprocal.note);
        await db.run(
          'INSERT OR IGNORE INTO matches (matchId, user1Id, user2Id, createdAt, initiatorNote, isHeartfelt) VALUES (?, ?, ?, ?, ?, ?)',
          matchId, callerUserId, targetCandidateId, now, (note || reciprocal.note || ''), hasNote ? 1 : 0
        );

        if (note) {
          await db.run(
            'INSERT INTO messages (messageId, senderId, receiverId, content, timestamp) VALUES (?, ?, ?, ?, ?)',
            generateId(), callerUserId, targetCandidateId, `💌 Heartfelt Note: ${note}`, now
          );
        } else if (reciprocal.note) {
          await db.run(
            'INSERT INTO messages (messageId, senderId, receiverId, content, timestamp) VALUES (?, ?, ?, ?, ?)',
            generateId(), targetCandidateId, callerUserId, `💌 Heartfelt Note: ${reciprocal.note}`, now
          );
        }

        const otherProfile = await db.get('SELECT * FROM profiles WHERE userId = ?', targetCandidateId);
        return sendJson(res, 200, {
          success: true,
          data: {
            isMatch: true,
            matchId: matchId,
            matchedCandidate: formatProfileResponse(otherProfile),
            isHeartfelt: hasNote
          }
        });
      }

      return sendJson(res, 200, {
        success: true,
        data: {
          isMatch: false,
          matchId: null,
          matchedCandidate: null,
          isHeartfelt: Boolean(note)
        }
      });
    }

    // 6. Matches: Pass Candidate
    if (pathname === '/api/matches/pass' && method === 'POST') {
      const callerUserId = (body.callerUserId || currentUserId).trim();
      const targetCandidateId = (body.targetCandidateId || '').trim();

      if (callerUserId !== currentUserId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden' });
      }
      if (!targetCandidateId) {
        return sendJson(res, 400, { success: false, error: 'targetCandidateId required' });
      }

      await db.run(
        'INSERT OR REPLACE INTO passes (id, callerUserId, targetCandidateId, createdAt) VALUES (?, ?, ?, ?)',
        generateId(), callerUserId, targetCandidateId, Date.now()
      );

      return sendJson(res, 200, { success: true, data: true });
    }

    // 7. Matches: Get Matches List
    if (pathname === '/api/matches' && method === 'GET') {
      const rows = await db.all(`
        SELECT m.*, 
          p.userId as pUserId, p.fullName, p.age, p.gender, p.interestedIn, p.city, p.country,
          p.occupation, p.relationshipIntention, p.bio, p.photosJson, p.promptAnswersJson,
          p.interestsJson, p.community, p.religion, p.motherTongue, p.heightCm,
          p.lifestyleAnswersJson, p.safetyFlagsJson, p.isProfileComplete
        FROM matches m
        JOIN profiles p ON (CASE WHEN m.user1Id = ? THEN m.user2Id ELSE m.user1Id END) = p.userId
        WHERE m.user1Id = ? OR m.user2Id = ?
        ORDER BY m.createdAt DESC
      `, currentUserId, currentUserId, currentUserId);

      const matches = rows.map(r => ({
        matchId: r.matchId,
        otherUser: formatProfileResponse({
          userId: r.pUserId,
          fullName: r.fullName,
          age: r.age,
          gender: r.gender,
          interestedIn: r.interestedIn,
          city: r.city,
          country: r.country,
          occupation: r.occupation,
          relationshipIntention: r.relationshipIntention,
          bio: r.bio,
          photosJson: r.photosJson,
          promptAnswersJson: r.promptAnswersJson,
          interestsJson: r.interestsJson,
          community: r.community,
          religion: r.religion,
          motherTongue: r.motherTongue,
          heightCm: r.heightCm,
          lifestyleAnswersJson: r.lifestyleAnswersJson,
          safetyFlagsJson: r.safetyFlagsJson,
          isProfileComplete: r.isProfileComplete
        }),
        createdAt: r.createdAt,
        isHeartfelt: Boolean(r.isHeartfelt),
        initiatorNote: r.initiatorNote || ''
      }));

      return sendJson(res, 200, { success: true, data: matches });
    }

    // 8. Chat: Send Message
    if (pathname === '/api/chat/messages' && method === 'POST') {
      const senderId = (body.senderId || currentUserId).trim();
      const receiverId = (body.receiverId || '').trim();
      const content = (body.content || '').trim();

      if (senderId !== currentUserId) {
        return sendJson(res, 403, { success: false, error: 'Sender mismatch' });
      }
      if (!receiverId || !content) {
        return sendJson(res, 400, { success: false, error: 'receiverId and content required' });
      }

      const msgId = generateId();
      const now = Date.now();
      await db.run(
        'INSERT INTO messages (messageId, senderId, receiverId, content, timestamp) VALUES (?, ?, ?, ?, ?)',
        msgId, senderId, receiverId, content, now
      );

      return sendJson(res, 200, {
        success: true,
        data: {
          messageId: msgId,
          senderId,
          receiverId,
          content,
          timestamp: now
        }
      });
    }

    // 9. Chat: Retrieve Messages
    if (pathname === '/api/chat/messages' && method === 'GET') {
      const otherUserId = (parsedUrl.searchParams.get('otherUserId') || '').trim();
      if (!otherUserId) {
        return sendJson(res, 400, { success: false, error: 'otherUserId query parameter required' });
      }

      const rows = await db.all(`
        SELECT * FROM messages
        WHERE (senderId = ? AND receiverId = ?) OR (senderId = ? AND receiverId = ?)
        ORDER BY timestamp ASC
      `, currentUserId, otherUserId, otherUserId, currentUserId);

      return sendJson(res, 200, { success: true, data: rows });
    }

    // 10. Account: Delete Account
    if (pathname.startsWith('/api/account/') && method === 'DELETE') {
      const userId = pathname.replace('/api/account/', '').trim();
      if (userId !== currentUserId) {
        return sendJson(res, 403, { success: false, error: 'Forbidden: Cannot delete other accounts' });
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
    if (dbConfig.isRemote) {
      console.log(`[Database] Connected to Turso database: ${dbConfig.url}`);
      console.log(`[Database] Auth Token: ${dbConfig.authToken ? 'Configured (authenticated)' : 'NOT set (warning: unauthenticated)'}`);
    } else {
      console.log(`[Database] Notice: DATABASE_URL not set in environment. Falling back to local SQLite file: ${DB_FILE}`);
    }
  });
}).catch(err => {
  console.error('Failed to initialize database schema:', err);
  process.exit(1);
});
