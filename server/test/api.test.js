import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createNotifier } from '../src/notify.js';
import { seedSample } from '../src/seed.js';
import { getSettings } from '../src/db.js';

// Monday 19 Oct 2026, 12:38 in Chennai (07:08 UTC)
const START = '2026-10-19T07:08:00Z';

async function setup(env = {}) {
  const db = openDb(':memory:');
  let t = new Date(START);
  const { app } = createApp({ db, env, clock: () => t });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return {
    db, call,
    setNow: (iso) => { t = new Date(iso); },
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

test('tasks: validation, default reminders, duplicates need confirmation', async () => {
  const x = await setup();
  try {
    let r = await x.call('POST', '/tasks', { title: '  ' });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /required/i);

    r = await x.call('POST', '/tasks', { title: 'Call vendor', due: '2026-10-20T11:00', priority: 'high', est_minutes: 30 });
    assert.equal(r.status, 201);
    assert.equal(r.json.task.reminders.length, 1);
    assert.equal(r.json.task.reminders[0].remind_local, '2026-10-20T10:00');
    assert.equal(r.json.task.reminders[0].status, 'pending');

    r = await x.call('POST', '/tasks', { title: 'call the vendor', due: '2026-10-20T15:00' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'duplicate');
    assert.equal(r.json.error.duplicates[0].title, 'Call vendor');

    r = await x.call('POST', '/tasks', { title: 'call the vendor', due: '2026-10-20T15:00', force: true });
    assert.equal(r.status, 201);

    r = await x.call('POST', '/tasks', { title: 'Call vendor', due: '2026-12-30' }); // far away date is not a duplicate
    assert.equal(r.status, 201);
  } finally { await x.close(); }
});

test('meetings: overlap warning, duplicate check, bad link and bad times are rejected', async () => {
  const x = await setup();
  try {
    let r = await x.call('POST', '/meetings', { title: 'Sync', start: '2026-10-20T10:00', end: '2026-10-20T11:00', attendees: 'Ravi, Meena' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.meeting.attendees, ['Ravi', 'Meena']);
    assert.equal(r.json.meeting.reminders.length, 2); // evening before + 15 min before

    r = await x.call('POST', '/meetings', { title: 'Planning', start: '2026-10-20T10:30', end: '2026-10-20T11:30' });
    assert.equal(r.status, 201);
    assert.match(r.json.warnings[0], /Overlaps with "Sync"/);

    r = await x.call('POST', '/meetings', { title: 'Sync', start: '2026-10-20T10:00', end: '2026-10-20T11:00' });
    assert.equal(r.status, 409);

    r = await x.call('POST', '/meetings', { title: 'Bad', start: '2026-10-20T10:00', end: '2026-10-20T09:00' });
    assert.equal(r.status, 400);
    r = await x.call('POST', '/meetings', { title: 'Bad link', start: '2026-10-20T10:00', link: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
  } finally { await x.close(); }
});

test('completing work updates status, gives a completion update and shows in the end-of-day summary', async () => {
  const x = await setup();
  try {
    const a = (await x.call('POST', '/tasks', { title: 'Prepare report', due: '2026-10-19T17:00', est_minutes: 60 })).json.task;
    await x.call('POST', '/tasks', { title: 'Email vendor', due: '2026-10-19T16:00', est_minutes: 20 });

    let r = await x.call('POST', `/tasks/${a.id}/complete`);
    assert.equal(r.status, 200);
    assert.equal(r.json.task.status, 'done');
    assert.equal(r.json.completion.remaining_count, 1);
    assert.match(r.json.completion.message, /Done: “Prepare report”/);
    assert.match(r.json.completion.message, /1 task left for today/);

    r = await x.call('GET', '/summary/end-of-day');
    assert.deepEqual(r.json.completed.map((t) => t.title), ['Prepare report']);
    assert.deepEqual(r.json.pending.map((t) => t.title), ['Email vendor']);
    assert.match(r.json.text, /✓ Prepare report/);

    r = await x.call('GET', '/activity');
    assert.ok(r.json.items.some((i) => i.action === 'completed' && i.title === 'Prepare report'));

    r = await x.call('POST', `/tasks/${a.id}/reopen`);
    assert.equal(r.json.task.status, 'open');
    r = await x.call('GET', '/summary/end-of-day');
    assert.equal(r.json.completed.length, 0);
    assert.equal(r.json.pending.length, 2);
  } finally { await x.close(); }
});

test('engine: reminder fires once, only in-app is claimed, push without keys is "skipped"', async () => {
  const x = await setup();
  try {
    await x.call('PUT', '/settings', { channels: { push: true, sms: true, call: false }, phone: '+919876543210' });
    await x.call('POST', '/meetings', { title: 'Client call', start: '2026-10-19T15:00', end: '2026-10-19T15:30', reminders: [{ kind: 'before', minutes: 15 }] });

    let r = await x.call('GET', '/notifications');
    assert.equal(r.json.notifications.filter((n) => n.kind === 'reminder').length, 0);

    x.setNow('2026-10-19T09:46:00Z'); // 15:16 IST — reminder (14:45) is due, meeting is 14 min away
    r = await x.call('GET', '/notifications');
    const rem = r.json.notifications.find((n) => n.kind === 'reminder');
    assert.ok(rem, 'reminder notification created');
    assert.match(rem.title, /Client call/);
    const byChannel = Object.fromEntries(rem.deliveries.map((d) => [d.channel, d]));
    assert.equal(byChannel['in-app'].status, 'sent');
    assert.equal(byChannel.push.status, 'skipped');
    assert.match(byChannel.push.detail, /VAPID/);
    assert.equal(byChannel.sms.status, 'skipped');
    assert.match(byChannel.sms.detail, /TWILIO/);

    r = await x.call('GET', '/notifications');
    assert.equal(r.json.notifications.filter((n) => n.kind === 'reminder').length, 1, 'does not fire twice');
    assert.ok(r.json.unread >= 1);
    await x.call('POST', '/notifications/read-all');
    r = await x.call('GET', '/notifications');
    assert.equal(r.json.unread, 0);
  } finally { await x.close(); }
});

test('engine: meeting-soon, deadline-at-risk and end-of-day notifications', async () => {
  const x = await setup();
  try {
    await x.call('POST', '/meetings', { title: 'Review', start: '2026-10-19T16:30', end: '2026-10-19T17:00', reminders: [] });
    await x.call('POST', '/tasks', { title: 'Big report', due: '2026-10-19T14:00', est_minutes: 120, reminders: [] });
    await x.call('POST', '/tasks', { title: 'Old invoice', due: '2026-10-18T17:00', reminders: [] });

    x.setNow('2026-10-19T10:50:00Z'); // 16:20 IST
    let r = await x.call('GET', '/notifications');
    const kinds = r.json.notifications.map((n) => `${n.kind}:${n.title}`);
    assert.ok(kinds.some((k) => k.startsWith('meeting_soon:Starting soon: Review')), kinds.join('\n'));
    assert.ok(kinds.some((k) => k.startsWith('deadline_risk:Overdue: Old invoice')), kinds.join('\n'));

    x.setNow('2026-10-19T12:45:00Z'); // 18:15 IST — after end-of-day time
    r = await x.call('GET', '/notifications');
    const eod = r.json.notifications.find((n) => n.kind === 'eod');
    assert.ok(eod);
    assert.match(eod.body, /done, \d+ still pending/);
  } finally { await x.close(); }
});

test('risk: a task needing more time than is left before its due time is flagged', async () => {
  const x = await setup();
  try {
    await x.call('POST', '/tasks', { title: 'Submit claims', due: '2026-10-19T13:30', est_minutes: 60, reminders: [] });
    const r = await x.call('GET', '/briefing/today');
    assert.equal(r.json.alerts.at_risk.length, 1);
    assert.equal(r.json.alerts.at_risk[0].risk.level, 'at_risk');
  } finally { await x.close(); }
});

test('search and filters; tomorrow view shows prep; review is stored', async () => {
  const x = await setup();
  try {
    await x.call('POST', '/tasks', { title: 'Draft offer plan', project: 'Campaigns', priority: 'low', due: '2026-10-22' });
    await x.call('POST', '/tasks', { title: 'Send targets', project: 'Sales', priority: 'high', due: '2026-10-20T10:00', est_minutes: 90 });
    await x.call('POST', '/meetings', { title: 'Monthly planning', project: 'Sales', start: '2026-10-20T09:30', end: '2026-10-20T10:30', prep: 'Print numbers', attendees: ['A', 'B'] });

    let r = await x.call('GET', '/search?q=offer');
    assert.deepEqual(r.json.items.map((i) => i.title), ['Draft offer plan']);
    r = await x.call('GET', '/search?project=sales');
    assert.equal(r.json.items.length, 2);
    r = await x.call('GET', '/search?priority=high');
    assert.deepEqual(r.json.items.map((i) => i.title), ['Send targets']);
    r = await x.call('GET', '/search?from=2026-10-21&to=2026-10-22&type=task');
    assert.deepEqual(r.json.items.map((i) => i.title), ['Draft offer plan']);
    r = await x.call('GET', '/search?from=nope');
    assert.equal(r.status, 400);

    r = await x.call('GET', '/briefing/tomorrow');
    assert.equal(r.json.date, '2026-10-20');
    assert.equal(r.json.meetings.length, 1);
    assert.ok(r.json.prep.some((p) => p.kind === 'prep' && /Print numbers/.test(p.text)));
    assert.ok(r.json.prep.some((p) => p.kind === 'block_time'));
    assert.equal(r.json.reviewed_at, null);
    await x.call('POST', '/briefing/review', { date: '2026-10-20' });
    r = await x.call('GET', '/briefing/tomorrow');
    assert.ok(r.json.reviewed_at);
  } finally { await x.close(); }
});

test('settings validation and recomputing day-before reminders', async () => {
  const x = await setup();
  try {
    let r = await x.call('PUT', '/settings', { timezone: 'Mars/Olympus' });
    assert.equal(r.status, 400);
    r = await x.call('PUT', '/settings', { work_start: '19:00', work_end: '18:00' });
    assert.equal(r.status, 400);
    r = await x.call('PUT', '/settings', { phone: 'call me' });
    assert.equal(r.status, 400);

    const m = (await x.call('POST', '/meetings', { title: 'Standup', start: '2026-10-21T09:30', reminders: [{ kind: 'day_before' }] })).json.meeting;
    assert.equal(m.reminders[0].remind_local, '2026-10-20T18:00');
    r = await x.call('PUT', '/settings', { day_before_time: '20:30' });
    assert.equal(r.status, 200);
    r = await x.call('GET', `/meetings/${m.id}`);
    assert.equal(r.json.meeting.reminders[0].remind_local, '2026-10-20T20:30');
  } finally { await x.close(); }
});

test('rescheduling moves reminders; snooze and dismiss work', async () => {
  const x = await setup();
  try {
    const t = (await x.call('POST', '/tasks', { title: 'File return', due: '2026-10-22T17:00' })).json.task;
    let r = await x.call('PATCH', `/tasks/${t.id}`, { due: '2026-10-23T12:00' });
    assert.equal(r.json.task.reminders[0].remind_local, '2026-10-23T11:00');
    const rid = r.json.task.reminders[0].id;
    r = await x.call('POST', `/reminders/${rid}/snooze`, { minutes: 5000 });
    assert.equal(r.status, 400);
    r = await x.call('POST', `/reminders/${rid}/snooze`, { minutes: 30 });
    assert.equal(r.status, 200);
    r = await x.call('POST', `/reminders/${rid}/dismiss`);
    assert.equal(r.status, 200);
    r = await x.call('GET', `/tasks/${t.id}`);
    assert.equal(r.json.task.reminders[0].status, 'dismissed');
  } finally { await x.close(); }
});

test('quick capture endpoint, calendar feed token and sample data', async () => {
  const x = await setup();
  try {
    let r = await x.call('POST', '/capture/parse', { text: 'Call Payal tomorrow at 10 and remind me 15 minutes before' });
    assert.equal(r.json.kind, 'meeting');
    r = await x.call('POST', '/capture/parse', { text: '' });
    assert.equal(r.status, 400);

    r = await x.call('POST', '/data/sample/load');
    assert.ok(r.json.tasks > 5 && r.json.meetings > 3);
    r = await x.call('POST', '/data/sample/load');
    assert.equal(r.json.skipped, true);

    r = await x.call('GET', '/integrations');
    const url = new URL(r.json.calendar_feed.url);
    assert.equal(r.json.push.status, 'not_connected');
    assert.equal(r.json.sms.status, 'not_connected');
    assert.equal(r.json.google_calendar.status, 'not_connected');
    assert.ok(!JSON.stringify(r.json).includes('AUTH_TOKEN='), 'no secrets in status');

    r = await x.call('GET', '/calendar.ics?token=wrong');
    assert.equal(r.status, 403);
    r = await x.call('GET', `/calendar.ics${url.search}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /BEGIN:VCALENDAR/);
    assert.match(r.text, /SUMMARY:Follow-up call with Payal/);
    assert.match(r.text, /BEGIN:VALARM/);

    r = await x.call('GET', '/briefing/today');
    assert.ok(r.json.meetings.length >= 3);
    assert.ok(r.json.tasks.completed.length === 2);
    assert.ok(r.json.tasks.overdue.length === 1);

    r = await x.call('DELETE', '/data/sample');
    assert.ok(r.json.tasks > 5);
    r = await x.call('GET', '/search');
    assert.equal(r.json.items.length, 0);
  } finally { await x.close(); }
});

test('notifier: SMS is "sent" only when the provider accepts it; provider errors are "failed"', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('channels', ?), ('phone', ?)").run(JSON.stringify({ push: false, sms: true, call: false }), JSON.stringify('+919876543210'));
  const env = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret-token', TWILIO_FROM_NUMBER: '+15005550006' };
  const calls = [];
  const okFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ status: 'queued' }) }; };
  const failFetch = async () => ({ ok: false, status: 400, json: async () => ({ message: 'Invalid To number' }) });

  const n = { id: null, kind: 'reminder', title: 'T', body: 'B' };
  let out = await createNotifier({ db, getSettings: () => getSettings(db), env, fetchImpl: okFetch }).deliver(n);
  assert.equal(out.find((d) => d.channel === 'sms').status, 'sent');
  assert.match(calls[0].url, /Accounts\/ACtest\/Messages\.json$/);
  assert.ok(!calls[0].init.body.toString().includes('secret-token'));

  out = await createNotifier({ db, getSettings: () => getSettings(db), env, fetchImpl: failFetch }).deliver(n);
  const sms = out.find((d) => d.channel === 'sms');
  assert.equal(sms.status, 'failed');
  assert.equal(sms.detail, 'Invalid To number');
});

test('seeded dashboard has realistic content', async () => {
  const db = openDb(':memory:');
  seedSample(db, getSettings(db), new Date(START));
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n >= 10);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM meetings').get().n >= 7);
});

test('auth: with APP_PASSWORD everything is locked until login; calendar feed and health stay reachable', async () => {
  const db = openDb(':memory:');
  const { app } = createApp({ db, env: { APP_PASSWORD: 'correct-horse-9' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const j = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  try {
    assert.equal((await j('/tasks')).status, 401);
    assert.equal((await j('/settings')).status, 401);
    assert.equal((await j('/health')).status, 200);
    assert.deepEqual(await (await j('/auth/status')).json(), { required: true, authenticated: false });
    assert.equal((await j('/calendar.ics?token=nope')).status, 403); // reachable, but token-protected

    const bad = await j('/auth/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(bad.status, 401);
    assert.ok(!bad.headers.get('set-cookie'));

    const ok = await j('/auth/login', { method: 'POST', body: JSON.stringify({ password: 'correct-horse-9' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const c = cookie.split(';')[0];
    assert.equal((await j('/settings', { headers: { Cookie: c } })).status, 200);
    assert.equal((await (await j('/auth/status', { headers: { Cookie: c } })).json()).authenticated, true);

    // forged / tampered cookie is rejected
    assert.equal((await j('/settings', { headers: { Cookie: 'dp_session=99999999999999.AAAA' } })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('auth: wrong passwords are rate limited; no APP_PASSWORD means open (localhost use)', async () => {
  const db = openDb(':memory:');
  const { app } = createApp({ db, env: { APP_PASSWORD: 'correct-horse-9' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (password) => fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  try {
    for (let i = 0; i < 8; i += 1) assert.equal((await post('x')).status, 401);
    assert.equal((await post('x')).status, 429);
    assert.equal((await post('correct-horse-9')).status, 429); // locked even for the right password until the window passes
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const open = await setup();
  try {
    assert.deepEqual((await open.call('GET', '/auth/status')).json, { required: false, authenticated: true });
    assert.equal((await open.call('GET', '/settings')).status, 200);
  } finally { await open.close(); }
});
