import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getFlag, setFlag, getSettings } from './db.js';
import { createApp } from './app.js';
import { seedSample } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.resolve(here, '../data/daypilot.db');

const db = openDb(DB_FILE);

if (getFlag(db, 'seeded') !== '1' && process.env.SEED_SAMPLE_DATA !== '0') {
  seedSample(db, getSettings(db), new Date());
  setFlag(db, 'seeded', '1');
  console.log('Loaded sample data (remove it any time from Settings → Sample data).');
}

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const extra = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
let allowedHosts = null;
if (loopback) allowedHosts = ['localhost', '127.0.0.1', '[::1]', ...extra];
else if (extra.length) allowedHosts = extra;

const password = process.env.APP_PASSWORD || '';
if (!loopback && !password && process.env.ALLOW_NO_AUTH !== '1') {
  console.error('Refusing to start: HOST is not localhost but APP_PASSWORD is not set, so anyone could read your data.');
  console.error('Set APP_PASSWORD (8+ characters) in server/.env or your hosting dashboard, then start again.');
  process.exit(1);
}
if (password && password.length < 8) {
  console.error('APP_PASSWORD must be at least 8 characters.');
  process.exit(1);
}
if (!password && !loopback) console.warn('WARNING: running without a password because ALLOW_NO_AUTH=1.');

const { app, tick } = createApp({
  db,
  env: process.env,
  staticDir: path.resolve(here, '../../client/dist'),
  allowedHosts,
});

const server = app.listen(PORT, HOST, () => {
  console.log(`DayPilot running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data file: ${DB_FILE}`);
});

const safeTick = () => tick().catch((e) => console.error('Reminder engine error:', e.message));
safeTick();
const timer = setInterval(safeTick, 30_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => { db.close(); process.exit(0); });
  });
}
