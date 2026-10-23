import crypto from 'node:crypto';
import { getFlag, setFlag } from './db.js';
import { HttpError } from './errors.js';

const COOKIE = 'dp_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const b64 = (buf) => buf.toString('base64url');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Single-user password login.
 * - Password comes only from the APP_PASSWORD environment variable (never stored in the DB or sent to the browser).
 * - Session = signed, expiring cookie (HttpOnly, SameSite=Lax). Changing the password signs everyone out.
 * - Wrong-password attempts are rate limited per client address.
 */
export function createAuth({ db, env = process.env, clock = () => new Date() }) {
  const password = env.APP_PASSWORD || '';
  const enabled = password.length > 0;

  let secret = getFlag(db, 'session_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setFlag(db, 'session_secret', secret); }
  const key = crypto.createHmac('sha256', secret).update(password).digest();
  const sign = (payload) => b64(crypto.createHmac('sha256', key).update(payload).digest());

  const fails = new Map(); // ip -> { n, first }

  function isAuthed(req) {
    if (!enabled) return true;
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    if (Number(exp) < clock().getTime()) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  function cookieFlags(req, maxAgeSec) {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  function login(req, res) {
    if (!enabled) return res.json({ ok: true, required: false });
    const ip = req.ip || 'unknown';
    const now = clock().getTime();
    const f = fails.get(ip);
    if (f && now - f.first > WINDOW_MS) fails.delete(ip);
    const cur = fails.get(ip);
    if (cur && cur.n >= MAX_FAILS) throw new HttpError(429, 'Too many wrong attempts. Wait 15 minutes and try again.');

    const given = sha(req.body?.password ?? '');
    const real = sha(password);
    if (!crypto.timingSafeEqual(given, real)) {
      fails.set(ip, { n: (cur?.n || 0) + 1, first: cur?.first || now });
      throw new HttpError(401, 'Wrong password.', { code: 'bad_password' });
    }
    fails.delete(ip);
    const exp = String(now + SESSION_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; ${cookieFlags(req, SESSION_MS / 1000)}`);
    return res.json({ ok: true });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req, 0)}`);
    res.json({ ok: true });
  }

  /** Express middleware: blocks everything except the paths in `open`. */
  function guard(open = []) {
    return (req, res, next) => {
      if (isAuthed(req) || open.includes(req.path)) return next();
      return res.status(401).json({ error: { code: 'auth', message: 'Please sign in.' } });
    };
  }

  return { enabled, isAuthed, login, logout, guard };
}
