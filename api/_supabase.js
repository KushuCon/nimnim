import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);

export function getEnvOrThrow(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function getSupabaseConfig() {
  return {
    url: getEnvOrThrow('SUPABASE_URL'),
    key: getEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

export async function supabaseRest(path, { method = 'GET', body } = {}) {
  const { url, key } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.hint)) || `Supabase error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function supabaseRpc(fnName, args = {}) {
  return supabaseRest(`rpc/${fnName}`, {
    method: 'POST',
    body: args,
  });
}

export function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  const out = {};
  cookieHeader.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i === -1) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

export function makeSessionCookie(token, maxAgeSeconds = 30 * 24 * 60 * 60) {
  return `nim_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return 'nim_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const hashHex = parts[2];
  const derived = await scryptAsync(password, salt, 64);
  const a = Buffer.from(hashHex, 'hex');
  const b = Buffer.from(derived.toString('hex'), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.nim_session;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const nowIso = new Date().toISOString();
  const rows = await supabaseRest(
    `sessions?select=id,user_id,expires_at&token_hash=eq.${tokenHash}&expires_at=gt.${encodeURIComponent(nowIso)}&limit=1`
  );
  if (!rows || !rows.length) return null;
  return rows[0];
}

export async function requireSession(req, res) {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return session;
}
