import {
  clearSessionCookie,
  getSession,
  hashPassword,
  hashToken,
  makeSessionCookie,
  randomToken,
  supabaseRest,
  verifyPassword,
} from './_supabase.js';

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function validateCreds(username, password) {
  if (!username || username.length < 3 || username.length > 24) {
    return 'Username must be 3-24 chars';
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    return 'Username can contain a-z, 0-9, _ only';
  }
  if (!password || password.length < 6 || password.length > 100) {
    return 'Password must be 6-100 chars';
  }
  return null;
}

async function createSession(userId, res) {
  const token = randomToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await supabaseRest('sessions', {
    method: 'POST',
    body: [{ user_id: userId, token_hash: tokenHash, expires_at: expiresAt }],
  });

  res.setHeader('Set-Cookie', makeSessionCookie(token));
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const session = await getSession(req);
      if (!session) return res.status(200).json({ user: null });

      const users = await supabaseRest(`users?select=id,username&id=eq.${session.user_id}&limit=1`);
      const user = users && users[0] ? users[0] : null;
      return res.status(200).json({ user });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const action = payload.action;

    if (action === 'logout') {
      const session = await getSession(req);
      if (session) {
        await supabaseRest(`sessions?id=eq.${session.id}`, { method: 'DELETE' });
      }
      res.setHeader('Set-Cookie', clearSessionCookie());
      return res.status(200).json({ ok: true });
    }

    if (action !== 'signup' && action !== 'login') {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const username = normalizeUsername(payload.username);
    const password = String(payload.password || '');
    const bad = validateCreds(username, password);
    if (bad) return res.status(400).json({ error: bad });

    const existing = await supabaseRest(`users?select=id,username,password_hash&username=eq.${encodeURIComponent(username)}&limit=1`);
    const userRow = existing && existing[0];

    if (action === 'signup') {
      if (userRow) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      const passwordHash = await hashPassword(password);
      const inserted = await supabaseRest('users', {
        method: 'POST',
        body: [{ username, password_hash: passwordHash }],
      });
      const user = inserted[0];
      await createSession(user.id, res);
      return res.status(200).json({ user: { id: user.id, username: user.username } });
    }

    if (!userRow) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const ok = await verifyPassword(password, userRow.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await createSession(userRow.id, res);
    return res.status(200).json({ user: { id: userRow.id, username: userRow.username } });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Auth error',
      detail: err.data || null,
    });
  }
}
