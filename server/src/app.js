import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, saveSettings, getCalendarToken } from './db.js';
import { HttpError } from './errors.js';
import { parseYmd, ymdOf, addDaysYmd } from './tz.js';
import {
  createTask, updateTask, completeTask, reopenTask, deleteTask, getTask,
  createMeeting, updateMeeting, deleteMeeting, getMeeting,
  searchItems, listProjects, listActivity,
} from './items.js';
import { buildDay, buildNextDay, buildEndOfDay, completionUpdate } from './briefing.js';
import { parseCapture } from './parser.js';
import { dismissReminder, snoozeReminder, recomputeAllPending } from './reminders.js';
import { createNotifier } from './notify.js';
import { runEngine } from './engine.js';
import { buildIcs } from './ics.js';
import { seedSample, clearSample } from './seed.js';
import { createAuth } from './auth.js';

export function createApp({ db, env = process.env, clock = () => new Date(), staticDir = null, allowedHosts = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting proxy (Render, Railway, Fly...) so https and client IPs are read correctly.
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  const getS = () => getSettings(db);
  const notifier = createNotifier({ db, getSettings: getS, env });
  const ctx = () => ({ db, s: getS(), now: clock() });

  let running = false;
  async function tick() {
    if (running) return [];
    running = true;
    try {
      const c = ctx();
      return await runEngine({ db, notifier, s: c.s, now: c.now });
    } finally {
      running = false;
    }
  }

  // Basic hardening. Without APP_PASSWORD the app only answers to the hosts you allow.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (allowedHosts) {
      const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      if (!allowedHosts.includes(host)) return res.status(403).json({ error: { message: 'Host not allowed' } });
    }
    return next();
  });

  const api = express.Router();
  api.use(express.json({ limit: '200kb' }));

  /* login (only active when APP_PASSWORD is set) */
  const auth = createAuth({ db, env, clock });
  api.get('/auth/status', (req, res) => res.json({ required: auth.enabled, authenticated: auth.isAuthed(req) }));
  api.post('/auth/login', (req, res) => auth.login(req, res));
  api.post('/auth/logout', (req, res) => auth.logout(req, res));
  api.use(auth.guard(['/health', '/calendar.ics']));

  const idOf = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid id');
    return id;
  };
  const dateParam = (v, c) => {
    if (v === undefined || v === '') return ymdOf(c.now, c.s.timezone);
    if (!parseYmd(String(v))) throw new HttpError(400, 'date must look like 2026-10-19');
    return String(v);
  };

  api.get('/health', (req, res) => res.json({ ok: true, time: clock().toISOString() }));

  /* settings */
  api.get('/settings', (req, res) => res.json({ settings: getS(), now: clock().toISOString() }));
  api.put('/settings', (req, res) => {
    const s = saveSettings(db, req.body || {});
    recomputeAllPending(db, s, clock());
    res.json({ settings: s });
  });

  /* tasks */
  api.get('/tasks', (req, res) => res.json({ items: searchItems(ctx(), { ...req.query, type: 'task' }) }));
  api.post('/tasks', (req, res) => res.status(201).json(createTask(ctx(), req.body || {})));
  api.get('/tasks/:id', (req, res) => res.json({ task: getTask(ctx(), idOf(req)) }));
  api.patch('/tasks/:id', (req, res) => res.json(updateTask(ctx(), idOf(req), req.body || {})));
  api.delete('/tasks/:id', (req, res) => { deleteTask(ctx(), idOf(req)); res.json({ ok: true }); });
  api.post('/tasks/:id/complete', (req, res) => {
    const c = ctx();
    const task = completeTask(c, idOf(req));
    res.json({ task, completion: completionUpdate(c, task) });
  });
  api.post('/tasks/:id/reopen', (req, res) => res.json({ task: reopenTask(ctx(), idOf(req)) }));

  /* meetings */
  api.get('/meetings', (req, res) => res.json({ items: searchItems(ctx(), { ...req.query, type: 'meeting' }) }));
  api.post('/meetings', (req, res) => res.status(201).json(createMeeting(ctx(), req.body || {})));
  api.get('/meetings/:id', (req, res) => res.json({ meeting: getMeeting(ctx(), idOf(req)) }));
  api.patch('/meetings/:id', (req, res) => res.json(updateMeeting(ctx(), idOf(req), req.body || {})));
  api.delete('/meetings/:id', (req, res) => { deleteMeeting(ctx(), idOf(req)); res.json({ ok: true }); });

  /* reminders */
  api.post('/reminders/:id/dismiss', (req, res) => {
    if (!dismissReminder(db, idOf(req))) throw new HttpError(404, 'Reminder not found');
    res.json({ ok: true });
  });
  api.post('/reminders/:id/snooze', (req, res) => {
    const minutes = Number(req.body?.minutes ?? 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, 'Snooze must be 1 to 1440 minutes');
    if (!snoozeReminder(db, idOf(req), minutes, clock())) throw new HttpError(404, 'Reminder not found');
    res.json({ ok: true });
  });

  /* briefings and summaries */
  api.get('/briefing/today', (req, res) => { const c = ctx(); res.json(buildDay(c, ymdOf(c.now, c.s.timezone))); });
  api.get('/briefing/tomorrow', (req, res) => { const c = ctx(); res.json(buildNextDay(c, addDaysYmd(ymdOf(c.now, c.s.timezone), 1))); });
  api.post('/briefing/review', (req, res) => {
    const c = ctx();
    const date = dateParam(req.body?.date, c);
    db.prepare('INSERT INTO day_reviews (date, reviewed_at) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET reviewed_at=excluded.reviewed_at')
      .run(date, c.now.toISOString());
    res.json({ ok: true, date, reviewed_at: c.now.toISOString() });
  });
  api.get('/summary/end-of-day', (req, res) => { const c = ctx(); res.json(buildEndOfDay(c, dateParam(req.query.date, c))); });
  api.get('/activity', (req, res) => { const c = ctx(); const date = dateParam(req.query.date, c); res.json({ date, items: listActivity(c, date) }); });

  /* search, projects, quick capture */
  api.get('/search', (req, res) => res.json({ items: searchItems(ctx(), req.query) }));
  api.get('/projects', (req, res) => res.json({ projects: listProjects(db) }));
  api.post('/capture/parse', (req, res) => {
    const c = ctx();
    res.json(parseCapture(req.body?.text, { now: c.now, settings: c.s }));
  });

  /* notifications */
  api.get('/notifications', async (req, res) => {
    await tick();
    const rows = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all();
    const dels = rows.length
      ? db.prepare(`SELECT * FROM deliveries WHERE notification_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(...rows.map((r) => r.id))
      : [];
    const notifications = rows.map((n) => ({
      ...n,
      deliveries: dels.filter((d) => d.notification_id === n.id).map((d) => ({ channel: d.channel, status: d.status, detail: d.detail })),
    }));
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get().n;
    res.json({ notifications, unread });
  });
  api.post('/notifications/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET read_at=? WHERE read_at IS NULL').run(clock().toISOString());
    res.json({ ok: true });
  });
  api.post('/notifications/:id/read', (req, res) => {
    db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL').run(clock().toISOString(), idOf(req));
    res.json({ ok: true });
  });
  api.post('/engine/tick', async (req, res) => { const created = await tick(); res.json({ created: created.length }); });

  /* integrations */
  api.get('/integrations', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.json(notifier.status(base, getCalendarToken(db)));
  });
  api.post('/integrations/:channel/test', async (req, res) => {
    const channel = req.params.channel;
    if (!['push', 'sms', 'call'].includes(channel)) throw new HttpError(400, 'Unknown channel');
    res.json(await notifier.test(channel));
  });
  api.post('/push/subscribe', (req, res) => {
    const sub = req.body || {};
    let ok = typeof sub.endpoint === 'string' && sub.keys && sub.keys.p256dh && sub.keys.auth;
    try { ok = ok && new URL(sub.endpoint).protocol === 'https:'; } catch { ok = false; }
    if (!ok) throw new HttpError(400, 'Invalid push subscription');
    db.prepare('INSERT INTO push_subscriptions (endpoint, data, created_at) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data')
      .run(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), clock().toISOString());
    res.json({ ok: true });
  });
  api.post('/push/unsubscribe', (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(String(req.body?.endpoint || ''));
    res.json({ ok: true });
  });
  api.get('/calendar.ics', (req, res) => {
    const given = Buffer.from(String(req.query.token || ''));
    const real = Buffer.from(getCalendarToken(db));
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) return res.status(403).type('text/plain').send('Invalid token');
    return res.type('text/calendar; charset=utf-8').send(buildIcs(db, clock()));
  });

  /* sample data */
  api.post('/data/sample/load', (req, res) => { const c = ctx(); res.json(seedSample(db, c.s, c.now)); });
  api.delete('/data/sample', (req, res) => res.json(clearSample(db)));

  api.use((req, res) => res.status(404).json({ error: { message: 'Not found' } }));
  app.use('/api', api);

  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      return res.sendFile(path.resolve(staticDir, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { message: 'Request body is not valid JSON' } });
    console.error(err);
    return res.status(500).json({ error: { message: 'Something went wrong on the server.' } });
  });

  return { app, tick, notifier };
}
