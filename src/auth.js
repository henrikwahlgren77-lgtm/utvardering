// Lösenord, sessioner, CSRF. Endast Node:s inbyggda crypto.
import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
export const SESSION_MS = 7 * 86400000;

const scryptAsync = (pw, salt) =>
  new Promise((resolve, reject) =>
    scrypt(pw.normalize('NFKC'), salt, KEYLEN, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))),
  );

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Dummy-hash så att okänt användarnamn kostar lika lång tid som fel lösenord.
let dummy;
export async function verifyPassword(pw, stored) {
  if (!stored) {
    dummy ??= await hashPassword('dummy-password-for-timing');
    stored = dummy;
    await verifyPassword(pw, stored);
    return false;
  }
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scryptAsync(pw, Buffer.from(s, 'base64url'));
  const want = Buffer.from(k, 'base64url');
  return key.length === want.length && timingSafeEqual(key, want);
}

export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 12 && pw.length <= 200;
}

export function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9._-]{3,32}$/.test(u);
}

export function createSession(st, userId, now = Date.now()) {
  const raw = token();
  const csrf = token(16);
  st.insSession.run(sha256(raw), userId, csrf, now + SESSION_MS);
  return { raw, csrf };
}

export function loadSession(st, raw, now = Date.now()) {
  if (!raw || raw.length > 100) return null;
  const row = st.session.get(sha256(raw), now);
  return row ? { userId: row.user_id, username: row.username, csrf: row.csrf } : null;
}
