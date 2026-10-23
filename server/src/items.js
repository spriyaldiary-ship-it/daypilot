import { parseLocal, localString, ymdOf, dayRange, parseYmd } from './tz.js';
import { HttpError, DuplicateError } from './errors.js';
import { replaceReminders, recomputeReminders, loadReminders, reminderOut, normalizeSpec } from './reminders.js';
import { findTaskDuplicates, findMeetingDuplicates } from './dupes.js';
import { assessTaskRisk } from './risk.js';

const bad = (message, field) => new HttpError(400, message, field ? { field } : {});

function text(v, max, field, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${field} must be text`, field);
  v = v.trim();
  if (required && !v) throw bad(`${field[0].toUpperCase()}${field.slice(1)} is required`, field);
  if (v.length > max) throw bad(`${field[0].toUpperCase()}${field.slice(1)} is too long (max ${max} characters)`, field);
  return v;
}

function intOrNull(v, lo, hi, field) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${field} must be a whole number from ${lo} to ${hi}`, field);
  return n;
}

function assertReminders(list) {
  if (!Array.isArray(list)) throw bad('Reminders must be a list', 'reminders');
  if (list.length > 10) throw bad('Up to 10 reminders per item', 'reminders');
  for (const r of list) if (!normalizeSpec(r)) throw bad('One of the reminders is not valid', 'reminders');
}

export function logActivity(db, now, action, type, id, title) {
  db.prepare('INSERT INTO activity (at, action, item_type, item_id, title) VALUES (?,?,?,?,?)')
    .run(now.toISOString(), action, type, id, title);
}

/* ---------------------------- serialisation ---------------------------- */

export function taskOut(row, s, now, reminders = []) {
  const due = row.due_at ? new Date(row.due_at) : null;
  return {
    type: 'task', id: row.id, title: row.title, description: row.description,
    priority: row.priority, est_minutes: row.est_minutes, project: row.project, status: row.status,
    due_at: row.due_at, due_has_time: Boolean(row.due_has_time),
    due_local: due ? (row.due_has_time ? localString(due, s.timezone) : ymdOf(due, s.timezone)) : null,
    completed_at: row.completed_at, created_at: row.created_at, is_sample: Boolean(row.is_sample),
    risk: assessTaskRisk(row, now, s),
    reminders: reminders.map((r) => reminderOut(r, s)),
  };
}

export function meetingOut(row, s, now, reminders = []) {
  const start = new Date(row.start_at), end = new Date(row.end_at);
  let phase = 'upcoming';
  if (row.status === 'cancelled') phase = 'cancelled';
  else if (end <= now) phase = 'past';
  else if (start <= now) phase = 'live';
  let attendees = [];
  try { attendees = JSON.parse(row.attendees); } catch { /* ignore */ }
  return {
    type: 'meeting', id: row.id, title: row.title, start_at: row.start_at, end_at: row.end_at,
    start_local: localString(start, s.timezone), end_local: localString(end, s.timezone),
    duration_min: Math.round((end - start) / 60000), location: row.location, link: row.link,
    attendees, notes: row.notes, prep: row.prep, project: row.project, status: row.status, phase,
    is_sample: Boolean(row.is_sample), reminders: reminders.map((r) => reminderOut(r, s)),
  };
}

export function tasksOut(ctx, rows) {
  const map = loadReminders(ctx.db, 'task', rows.map((r) => r.id));
  return rows.map((r) => taskOut(r, ctx.s, ctx.now, map.get(r.id) || []));
}

export function meetingsOut(ctx, rows) {
  const map = loadReminders(ctx.db, 'meeting', rows.map((r) => r.id));
  return rows.map((r) => meetingOut(r, ctx.s, ctx.now, map.get(r.id) || []));
}

/* -------------------------------- tasks -------------------------------- */

function parseDue(v, s) {
  if (v == null || v === '') return { due_at: null, due_has_time: 1 };
  if (typeof v !== 'string') throw bad('Invalid due date', 'due');
  const p = parseLocal(v, s.timezone, { defaultHm: s.work_end });
  if (!p) throw bad('Due date must look like 2026-10-25 or 2026-10-25T17:00', 'due');
  return { due_at: p.date.toISOString(), due_has_time: p.hasTime ? 1 : 0 };
}

function cleanTask(b, s) {
  const priority = b.priority || 'medium';
  if (!['high', 'medium', 'low'].includes(priority)) throw bad('Priority must be high, medium or low', 'priority');
  return {
    title: text(b.title, 200, 'title', { required: true }),
    description: text(b.description, 5000, 'description'),
    ...parseDue(b.due, s),
    priority,
    est_minutes: intOrNull(b.est_minutes, 1, 1440, 'estimate'),
    project: text(b.project, 60, 'project'),
  };
}

export function getTask(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Task not found');
  return tasksOut(ctx, [row])[0];
}

export function createTask(ctx, body) {
  const { db, s, now } = ctx;
  const t = cleanTask(body, s);
  if (body.reminders !== undefined) assertReminders(body.reminders);
  if (!body.force) {
    const dupes = findTaskDuplicates(db, t, s);
    if (dupes.length) throw new DuplicateError('task', tasksOut(ctx, dupes));
  }
  const ts = now.toISOString();
  const r = db.prepare(
    `INSERT INTO tasks (title, description, due_at, due_has_time, priority, est_minutes, project, status, created_at, updated_at, is_sample)
     VALUES (?,?,?,?,?,?,?, 'open', ?, ?, 0)`,
  ).run(t.title, t.description, t.due_at, t.due_has_time, t.priority, t.est_minutes, t.project, ts, ts);
  const id = Number(r.lastInsertRowid);
  const specs = body.reminders !== undefined ? body.reminders : t.due_at ? s.default_task_reminders : [];
  replaceReminders(db, 'task', id, specs, t.due_at ? new Date(t.due_at) : null, s, now);
  logActivity(db, now, 'created', 'task', id, t.title);
  return { task: getTask(ctx, id), warnings: [] };
}

export function updateTask(ctx, id, body) {
  const { db, s, now } = ctx;
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Task not found');
  const due = row.due_at ? new Date(row.due_at) : null;
  const merged = {
    title: row.title, description: row.description, priority: row.priority,
    est_minutes: row.est_minutes, project: row.project,
    due: due ? (row.due_has_time ? localString(due, s.timezone) : ymdOf(due, s.timezone)) : null,
    ...body,
  };
  const t = cleanTask(merged, s);
  if (body.reminders !== undefined) assertReminders(body.reminders);
  db.prepare(
    `UPDATE tasks SET title=?, description=?, due_at=?, due_has_time=?, priority=?, est_minutes=?, project=?, updated_at=? WHERE id=?`,
  ).run(t.title, t.description, t.due_at, t.due_has_time, t.priority, t.est_minutes, t.project, now.toISOString(), id);
  const anchor = t.due_at ? new Date(t.due_at) : null;
  const done = row.status === 'done';
  if (body.reminders !== undefined) replaceReminders(db, 'task', id, body.reminders, anchor, s, now, { done });
  else if (t.due_at !== row.due_at) recomputeReminders(db, 'task', id, anchor, s, now, { done });
  return { task: getTask(ctx, id), warnings: [] };
}

export function completeTask(ctx, id) {
  const { db, s, now } = ctx;
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Task not found');
  if (row.status !== 'done') {
    db.prepare("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?").run(now.toISOString(), now.toISOString(), id);
    db.prepare("UPDATE reminders SET status='skipped' WHERE item_type='task' AND item_id=? AND status='pending'").run(id);
    logActivity(db, now, 'completed', 'task', id, row.title);
  }
  return getTask(ctx, id);
}

export function reopenTask(ctx, id) {
  const { db, s, now } = ctx;
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Task not found');
  if (row.status === 'done') {
    db.prepare("UPDATE tasks SET status='open', completed_at=NULL, updated_at=? WHERE id=?").run(now.toISOString(), id);
    recomputeReminders(db, 'task', id, row.due_at ? new Date(row.due_at) : null, s, now);
    logActivity(db, now, 'reopened', 'task', id, row.title);
  }
  return getTask(ctx, id);
}

export function deleteTask(ctx, id) {
  const { db } = ctx;
  const row = db.prepare('SELECT id FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Task not found');
  db.prepare('DELETE FROM reminders WHERE item_type=? AND item_id=?').run('task', id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
}

/* ------------------------------- meetings ------------------------------ */

function cleanAttendees(v) {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out = list.map((x) => String(x).trim()).filter(Boolean);
  if (out.length > 50) throw bad('Up to 50 attendees', 'attendees');
  if (out.some((x) => x.length > 100)) throw bad('Attendee names are too long', 'attendees');
  return out;
}

function cleanMeeting(b, s) {
  const st = parseLocal(b.start, s.timezone);
  if (!st || !st.hasTime) throw bad('Start must include a date and time', 'start');
  const en = b.end ? parseLocal(b.end, s.timezone) : null;
  const start = st.date;
  const end = en && en.hasTime ? en.date : new Date(start.getTime() + s.default_meeting_minutes * 60000);
  if (end <= start) throw bad('End time must be after the start time', 'end');
  const link = text(b.link, 500, 'link');
  if (link) {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(link).protocol); } catch { ok = false; }
    if (!ok) throw bad('Link must start with http:// or https://', 'link');
  }
  return {
    title: text(b.title, 200, 'title', { required: true }),
    start_at: start.toISOString(), end_at: end.toISOString(),
    location: text(b.location, 200, 'location'), link,
    attendees: JSON.stringify(cleanAttendees(b.attendees)),
    notes: text(b.notes, 5000, 'notes'), prep: text(b.prep, 2000, 'prep'),
    project: text(b.project, 60, 'project'),
  };
}

export function getMeeting(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Meeting not found');
  return meetingsOut(ctx, [row])[0];
}

function overlapWarnings(ctx, m, excludeId) {
  const rows = ctx.db.prepare("SELECT * FROM meetings WHERE status='scheduled' AND start_at < ? AND end_at > ? AND id != ?")
    .all(m.end_at, m.start_at, excludeId ?? -1);
  return rows.map((r) => `Overlaps with "${r.title}"`);
}

export function createMeeting(ctx, body) {
  const { db, s, now } = ctx;
  const m = cleanMeeting(body, s);
  if (body.reminders !== undefined) assertReminders(body.reminders);
  if (!body.force) {
    const dupes = findMeetingDuplicates(db, m, s);
    if (dupes.length) throw new DuplicateError('meeting', meetingsOut(ctx, dupes));
  }
  const ts = now.toISOString();
  const r = db.prepare(
    `INSERT INTO meetings (title, start_at, end_at, location, link, attendees, notes, prep, project, status, created_at, updated_at, is_sample)
     VALUES (?,?,?,?,?,?,?,?,?, 'scheduled', ?, ?, 0)`,
  ).run(m.title, m.start_at, m.end_at, m.location, m.link, m.attendees, m.notes, m.prep, m.project, ts, ts);
  const id = Number(r.lastInsertRowid);
  replaceReminders(db, 'meeting', id, body.reminders !== undefined ? body.reminders : s.default_meeting_reminders, new Date(m.start_at), s, now);
  logActivity(db, now, 'created', 'meeting', id, m.title);
  return { meeting: getMeeting(ctx, id), warnings: overlapWarnings(ctx, m, id) };
}

export function updateMeeting(ctx, id, body) {
  const { db, s, now } = ctx;
  const row = db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Meeting not found');
  const oldStart = new Date(row.start_at), oldEnd = new Date(row.end_at);
  const merged = {
    title: row.title, location: row.location, link: row.link, attendees: JSON.parse(row.attendees),
    notes: row.notes, prep: row.prep, project: row.project,
    start: localString(oldStart, s.timezone), end: localString(oldEnd, s.timezone), ...body,
  };
  if (body.start && !body.end) {
    const ns = parseLocal(body.start, s.timezone);
    if (ns && ns.hasTime) merged.end = localString(new Date(ns.date.getTime() + (oldEnd - oldStart)), s.timezone);
  }
  const m = cleanMeeting(merged, s);
  let status = row.status;
  if (body.status !== undefined) {
    if (!['scheduled', 'cancelled'].includes(body.status)) throw bad('Status must be scheduled or cancelled', 'status');
    status = body.status;
  }
  if (body.reminders !== undefined) assertReminders(body.reminders);
  db.prepare(
    `UPDATE meetings SET title=?, start_at=?, end_at=?, location=?, link=?, attendees=?, notes=?, prep=?, project=?, status=?, updated_at=? WHERE id=?`,
  ).run(m.title, m.start_at, m.end_at, m.location, m.link, m.attendees, m.notes, m.prep, m.project, status, now.toISOString(), id);
  const anchor = new Date(m.start_at);
  const done = status === 'cancelled';
  if (body.reminders !== undefined) replaceReminders(db, 'meeting', id, body.reminders, anchor, s, now, { done });
  else recomputeReminders(db, 'meeting', id, anchor, s, now, { done });
  if (status !== row.status) logActivity(db, now, status === 'cancelled' ? 'cancelled' : 'restored', 'meeting', id, m.title);
  return { meeting: getMeeting(ctx, id), warnings: status === 'scheduled' ? overlapWarnings(ctx, m, id) : [] };
}

export function deleteMeeting(ctx, id) {
  const { db } = ctx;
  if (!db.prepare('SELECT id FROM meetings WHERE id=?').get(id)) throw new HttpError(404, 'Meeting not found');
  db.prepare('DELETE FROM reminders WHERE item_type=? AND item_id=?').run('meeting', id);
  db.prepare('DELETE FROM meetings WHERE id=?').run(id);
}

/* ------------------------- search, filters, lists ----------------------- */

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export function searchItems(ctx, f = {}) {
  const { db, s, now } = ctx;
  const type = ['task', 'meeting', 'all'].includes(f.type) ? f.type : 'all';
  const status = ['open', 'done', 'all', 'cancelled'].includes(f.status) ? f.status : 'all';
  if (f.priority && !PRIORITY_RANK.hasOwnProperty(f.priority)) throw bad('Priority must be high, medium or low', 'priority');
  const q = f.q ? String(f.q).trim() : '';
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  let from = null, to = null;
  if (f.from) { if (!parseYmd(f.from)) throw bad('"from" must be a date like 2026-10-19', 'from'); from = dayRange(f.from, s.timezone).start; }
  if (f.to) { if (!parseYmd(f.to)) throw bad('"to" must be a date like 2026-10-19', 'to'); to = dayRange(f.to, s.timezone).end; }
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 500);
  const items = [];

  if (type !== 'meeting' && status !== 'cancelled') {
    const w = [], p = [];
    if (status === 'open') w.push("status='open'");
    if (status === 'done') w.push("status='done'");
    if (f.priority) { w.push('priority=?'); p.push(f.priority); }
    if (f.project) { w.push('project=? COLLATE NOCASE'); p.push(f.project); }
    if (like) {
      w.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\')");
      p.push(like, like, like);
    }
    if (from) { w.push('due_at >= ?'); p.push(from.toISOString()); }
    if (to) { w.push('due_at < ?'); p.push(to.toISOString()); }
    const rows = db.prepare(`SELECT * FROM tasks ${w.length ? `WHERE ${w.join(' AND ')}` : ''} LIMIT ?`).all(...p, limit);
    items.push(...tasksOut(ctx, rows));
  }

  if (type !== 'task' && !f.priority) {
    const w = [], p = [];
    if (status === 'open') { w.push("status='scheduled' AND end_at >= ?"); p.push(now.toISOString()); }
    if (status === 'done') { w.push("status='scheduled' AND end_at < ?"); p.push(now.toISOString()); }
    if (status === 'cancelled') w.push("status='cancelled'");
    if (f.project) { w.push('project=? COLLATE NOCASE'); p.push(f.project); }
    if (like) {
      w.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR attendees LIKE ? ESCAPE '\\' OR prep LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\')");
      p.push(like, like, like, like, like, like);
    }
    if (from) { w.push('start_at >= ?'); p.push(from.toISOString()); }
    if (to) { w.push('start_at < ?'); p.push(to.toISOString()); }
    const rows = db.prepare(`SELECT * FROM meetings ${w.length ? `WHERE ${w.join(' AND ')}` : ''} LIMIT ?`).all(...p, limit);
    items.push(...meetingsOut(ctx, rows));
  }

  const when = (i) => (i.type === 'task' ? i.due_at : i.start_at);
  if (status === 'done') {
    items.sort((a, b) => String(b.completed_at || b.start_at).localeCompare(String(a.completed_at || a.start_at)));
  } else {
    items.sort((a, b) => {
      const wa = when(a), wb = when(b);
      if (wa && wb && wa !== wb) return wa.localeCompare(wb);
      if (wa && !wb) return -1;
      if (!wa && wb) return 1;
      return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    });
  }
  return items.slice(0, limit);
}

export function listProjects(db) {
  return db.prepare(
    `SELECT project FROM (SELECT project FROM tasks UNION SELECT project FROM meetings) WHERE project != '' ORDER BY project COLLATE NOCASE`,
  ).all().map((r) => r.project);
}

export function listActivity(ctx, ymd) {
  const { start, end } = dayRange(ymd, ctx.s.timezone);
  return ctx.db.prepare('SELECT * FROM activity WHERE at >= ? AND at < ? ORDER BY at DESC, id DESC')
    .all(start.toISOString(), end.toISOString());
}
