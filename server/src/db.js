import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isValidTz, normHm } from './tz.js';
import { normalizeSpec } from './reminders.js';
import { HttpError } from './errors.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  due_has_time INTEGER NOT NULL DEFAULT 1,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  est_minutes INTEGER,
  project TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_at);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  prep TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings (start_at);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL CHECK (item_type IN ('task','meeting')),
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('before','day_before','absolute')),
  minutes INTEGER,
  clock TEXT,
  remind_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','fired','dismissed','skipped')),
  fired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_item ON reminders (item_type, item_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id INTEGER,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_n ON deliveries (notification_id);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity (at);

CREATE TABLE IF NOT EXISTS day_reviews (date TEXT PRIMARY KEY, reviewed_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Kolkata',
  work_start: '09:00',
  work_end: '18:00',
  work_days: [1, 2, 3, 4, 5],
  eod_time: '18:00',
  day_before_time: '18:00',
  meeting_headsup_minutes: 10,
  default_meeting_minutes: 30,
  risk_hours: 3,
  default_meeting_reminders: [{ kind: 'day_before' }, { kind: 'before', minutes: 15 }],
  default_task_reminders: [{ kind: 'before', minutes: 60 }],
  channels: { push: false, sms: false, call: false },
  phone: '',
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  ensureCalendarToken(db);
  return db;
}

export function getSettings(db) {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    try { s[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
  }
  return s;
}

function rawGet(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}

function rawSet(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export const getFlag = (db, key) => rawGet(db, `flag:${key}`);
export const setFlag = (db, key, value) => rawSet(db, `flag:${key}`, String(value));

export function ensureCalendarToken(db) {
  let t = rawGet(db, 'secret:calendar_token');
  if (!t) {
    t = crypto.randomBytes(18).toString('hex');
    rawSet(db, 'secret:calendar_token', t);
  }
  return t;
}

export const getCalendarToken = (db) => rawGet(db, 'secret:calendar_token');

export function saveSettings(db, input) {
  const bad = (m, field) => { throw new HttpError(400, m, { field }); };
  const clean = {};
  const intIn = (v, lo, hi, field) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) bad(`Must be a whole number from ${lo} to ${hi}`, field);
    return n;
  };
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    switch (k) {
      case 'timezone':
        if (!isValidTz(v)) bad('Unknown time zone', k);
        clean[k] = v;
        break;
      case 'work_start': case 'work_end': case 'eod_time': case 'day_before_time': {
        const h = normHm(v);
        if (!h) bad('Use 24-hour HH:MM format', k);
        clean[k] = h;
        break;
      }
      case 'work_days':
        if (!Array.isArray(v) || !v.length || v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad('Pick at least one working day', k);
        clean[k] = [...new Set(v)].sort();
        break;
      case 'meeting_headsup_minutes': clean[k] = intIn(v, 0, 120, k); break;
      case 'default_meeting_minutes': clean[k] = intIn(v, 5, 480, k); break;
      case 'risk_hours': clean[k] = intIn(v, 1, 48, k); break;
      case 'default_meeting_reminders': case 'default_task_reminders': {
        if (!Array.isArray(v) || v.length > 6) bad('Up to 6 default reminders', k);
        const specs = v.map((x) => normalizeSpec(x, { allowAbsolute: false }));
        if (specs.some((x) => !x)) bad('Invalid reminder', k);
        clean[k] = specs;
        break;
      }
      case 'channels': {
        if (!v || typeof v !== 'object') bad('Invalid channels', k);
        clean[k] = { push: Boolean(v.push), sms: Boolean(v.sms), call: Boolean(v.call) };
        break;
      }
      case 'phone':
        if (typeof v !== 'string' || (v && !/^\+?[0-9 ()-]{7,20}$/.test(v.trim()))) bad('Enter a phone number with country code, e.g. +919876543210', k);
        clean[k] = v.trim();
        break;
      default: break;
    }
  }
  const merged = { ...getSettings(db), ...clean };
  if (merged.work_start >= merged.work_end) bad('Work start must be before work end', 'work_start');
  for (const [k, v] of Object.entries(clean)) rawSet(db, k, JSON.stringify(v));
  return getSettings(db);
}
