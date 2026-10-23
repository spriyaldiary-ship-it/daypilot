import { atLocal, ymdOf, parts, weekdayOf } from './tz.js';
import { fmtTime, humanMinutes, plural } from './format.js';
import { tasksOut } from './items.js';
import { buildEndOfDay } from './briefing.js';

function insertNotification(db, n, now) {
  const r = db.prepare(
    'INSERT OR IGNORE INTO notifications (kind, title, body, ref_type, ref_id, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(n.kind, n.title, n.body || '', n.ref_type || null, n.ref_id ?? null, n.dedupe_key || null, now.toISOString());
  if (r.changes === 0) return null;
  return db.prepare('SELECT * FROM notifications WHERE id=?').get(Number(r.lastInsertRowid));
}

function inWorkingHours(now, s) {
  const tz = s.timezone;
  const day = ymdOf(now, tz);
  if (!s.work_days.includes(weekdayOf(day))) return false;
  return now >= atLocal(day, s.work_start, tz) && now < atLocal(day, s.work_end, tz);
}

// Runs the proactive checks. Safe to call as often as you like: every notification has a dedupe key.
export async function runEngine({ db, notifier, s, now }) {
  const tz = s.timezone;
  const ctx = { db, s, now };
  const created = [];
  const add = (n) => { const row = insertNotification(db, n, now); if (row) created.push(row); return row; };

  // 1. Reminders that are due
  const due = db.prepare("SELECT * FROM reminders WHERE status='pending' AND remind_at <= ? ORDER BY remind_at").all(now.toISOString());
  for (const r of due) {
    const item = r.item_type === 'task'
      ? db.prepare('SELECT * FROM tasks WHERE id=?').get(r.item_id)
      : db.prepare('SELECT * FROM meetings WHERE id=?').get(r.item_id);
    if (!item || item.status === 'done' || item.status === 'cancelled') {
      db.prepare("UPDATE reminders SET status='skipped' WHERE id=?").run(r.id);
      continue;
    }
    db.prepare("UPDATE reminders SET status='fired', fired_at=? WHERE id=?").run(now.toISOString(), r.id);
    const at = new Date(r.item_type === 'task' ? item.due_at : item.start_at);
    const mins = Math.round((at - now) / 60000);
    let when;
    if (r.item_type === 'meeting') {
      when = mins > 0 ? `Starts at ${fmtTime(at, tz)} (in ${humanMinutes(mins)})` : `Started at ${fmtTime(at, tz)}`;
      if (item.location) when += ` · ${item.location}`;
    } else {
      when = mins > 0 ? `Due ${item.due_has_time ? `at ${fmtTime(at, tz)} ` : ''}(in ${humanMinutes(mins)})` : 'Due now';
    }
    const late = (now - new Date(r.remind_at)) / 60000;
    if (late > 10) when += ` · this reminder was due ${fmtTime(new Date(r.remind_at), tz)} (the app was not running)`;
    add({
      kind: 'reminder', title: `Reminder: ${item.title}`, body: when,
      ref_type: r.item_type, ref_id: item.id, dedupe_key: `reminder:${r.id}:${r.remind_at}`,
    });
  }

  // 2. Meetings that are about to start
  if (s.meeting_headsup_minutes > 0) {
    const horizon = new Date(now.getTime() + s.meeting_headsup_minutes * 60000).toISOString();
    const soon = db.prepare("SELECT * FROM meetings WHERE status='scheduled' AND start_at > ? AND start_at <= ?").all(now.toISOString(), horizon);
    for (const m of soon) {
      const mins = Math.max(1, Math.round((new Date(m.start_at) - now) / 60000));
      add({
        kind: 'meeting_soon', title: `Starting soon: ${m.title}`,
        body: `In ${humanMinutes(mins)} (${fmtTime(new Date(m.start_at), tz)})${m.link ? ' · video link attached' : m.location ? ` · ${m.location}` : ''}`,
        ref_type: 'meeting', ref_id: m.id, dedupe_key: `soon:${m.id}:${m.start_at}`,
      });
    }
  }

  // 3. Deadlines at risk / overdue (only during working hours so nothing pings at 3 a.m.)
  if (inWorkingHours(now, s)) {
    const today = ymdOf(now, tz);
    const horizon = new Date(now.getTime() + 48 * 3600000).toISOString();
    const rows = db.prepare("SELECT * FROM tasks WHERE status='open' AND due_at IS NOT NULL AND due_at < ?").all(horizon);
    for (const t of tasksOut(ctx, rows)) {
      if (!t.risk) continue;
      const overdue = t.risk.level === 'overdue';
      add({
        kind: 'deadline_risk', title: `${overdue ? 'Overdue' : 'Deadline at risk'}: ${t.title}`, body: t.risk.reason,
        ref_type: 'task', ref_id: t.id, dedupe_key: `${overdue ? 'overdue' : 'risk'}:${t.id}:${today}`,
      });
    }
  }

  // 4. End-of-day summary once the chosen time has passed
  const today = ymdOf(now, tz);
  if (now >= atLocal(today, s.eod_time, tz)) {
    const exists = db.prepare('SELECT 1 FROM notifications WHERE dedupe_key=?').get(`eod:${today}`);
    if (!exists) {
      const sm = buildEndOfDay(ctx, today);
      add({ kind: 'eod', title: 'Your end-of-day summary is ready', body: sm.headline, dedupe_key: `eod:${today}` });
    }
  }

  for (const n of created) await notifier.deliver(n);
  return created;
}
