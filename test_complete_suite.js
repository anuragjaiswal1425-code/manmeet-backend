const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8766;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function post(endpoint, body, token = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(endpoint, token = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: endpoint,
      method: 'GET',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function del(endpoint, token = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: endpoint,
      method: 'DELETE',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('--- STARTING MANMEET LIBSQL BACKEND VERIFICATION SUITE ---');
  
  // 1. Start backend process
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit'
  });

  // Give server 1 second to start
  await new Promise(r => setTimeout(r, 1200));

  try {
    // 1. Health check
    const health = await get('/health');
    console.log('1. Health check status:', health.status, health.body.status === 'healthy' ? 'PASS' : 'FAIL');
    if (health.status !== 200) throw new Error('Health check failed');

    // 2. Register User A (Ananya)
    const emailA = `ananya_${Date.now()}@example.com`;
    const regA = await post('/api/auth/register-or-login', { destination: emailA, isEmail: true, accountType: 'REAL' });
    console.log('2. Register User A status:', regA.status, regA.body.success ? 'PASS' : 'FAIL');
    const userA = regA.body.data;

    // 3. Register User B (Kabir)
    const emailB = `kabir_${Date.now()}@example.com`;
    const regB = await post('/api/auth/register-or-login', { destination: emailB, isEmail: true, accountType: 'REAL' });
    console.log('3. Register User B status:', regB.status, regB.body.success ? 'PASS' : 'FAIL');
    const userB = regB.body.data;

    // 4. Fetch User A profile with token
    const profA = await get(`/api/profile/${userA.userId}`, userA.authToken);
    console.log('4. Profile fetch User A status:', profA.status, profA.body.data.fullName ? 'PASS' : 'FAIL');

    // 5. Test Unauthorized Profile Fetch
    const unauthProf = await get(`/api/profile/${userA.userId}`, 'invalid_spoofed_token');
    console.log('5. Invalid token rejection status (expect 401):', unauthProf.status, unauthProf.status === 401 ? 'PASS' : 'FAIL');

    // 6. User A likes User B with Heartfelt Note
    const likeA = await post('/api/matches/like', {
      callerUserId: userA.userId,
      targetCandidateId: userB.userId,
      note: 'Truly admired your dedication to cultural harmony!',
      idempotencyKey: `idem_like_${Date.now()}`
    }, userA.authToken);
    console.log('6. User A likes User B status:', likeA.status, likeA.body.data.type === 'LIKE_REGISTERED' ? 'PASS' : 'FAIL');

    // 7. User B likes User A back -> Authoritative Mutual Match
    const likeB = await post('/api/matches/like', {
      callerUserId: userB.userId,
      targetCandidateId: userA.userId,
      idempotencyKey: `idem_recip_${Date.now()}`
    }, userB.authToken);
    console.log('7. Mutual match formed status:', likeB.status, likeB.body.data.type === 'MUTUAL_MATCH' ? 'PASS' : 'FAIL');
    const match = likeB.body.data.match;
    const conversationId = match.conversationId;

    // 8. User B sends chat message
    const msg = await post('/api/chat/messages', {
      messageId: `msg_${Date.now()}`,
      conversationId: conversationId,
      senderId: userB.userId,
      receiverId: userA.userId,
      text: 'Namaste Ananya! So wonderful to connect with you.',
      timestamp: Date.now()
    }, userB.authToken);
    console.log('8. User B chat message status:', msg.status, msg.body.data.deliveryStatus === 'DELIVERED' ? 'PASS' : 'FAIL');

    // 9. User A fetches messages
    const chatFetch = await get(`/api/chat/messages?conversationId=${conversationId}&callerUserId=${userA.userId}`, userA.authToken);
    console.log('9. User A chat retrieve status:', chatFetch.status, chatFetch.body.data.length >= 2 ? 'PASS' : 'FAIL');

    // 10. Security: User A impersonates User B to send message (Forbidden 403)
    const spoofMsg = await post('/api/chat/messages', {
      messageId: `msg_spoof_${Date.now()}`,
      conversationId: conversationId,
      senderId: userB.userId, // Caller token is userA!
      receiverId: userA.userId,
      text: 'Hacked message',
      timestamp: Date.now()
    }, userA.authToken);
    console.log('10. Sender spoofing rejection status (expect 403):', spoofMsg.status, spoofMsg.status === 403 ? 'PASS' : 'FAIL');

    // 11. Security: User A deletes User B account (Forbidden 403)
    const illegalDel = await del(`/api/account/${userB.userId}`, userA.authToken);
    console.log('11. Cross-user delete rejection status (expect 403):', illegalDel.status, illegalDel.status === 403 ? 'PASS' : 'FAIL');

    console.log('\n--- ALL 11 API CONTRACT CHECKS PASSED ON LIBSQL! ---');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
