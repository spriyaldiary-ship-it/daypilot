import { addDaysYmd, atLocal, ymdOf, normHm, parseLocal, localString } from './tz.js';

const MAX_BEFORE = 60 * 24 * 30;

// A reminder "spec" is one of:
//   { kind: 'before', minutes }        N minutes before the meeting start / task due time
//   { kind: 'day_before', clock? }     the previous day at a preferred time (default from settings)
//   { kind: 'absolute', at }           a fixed local date-time "YYYY-MM-DDTHH:mm"
export function normalizeSpec(raw, { allowAbsolute = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'before') {
    const m = Number(raw.minutes);
    if (!Number.isInteger(m) || m < 0 || m > MAX_BEFORE) return null;
    return { kind: 'before', minutes: m };
  }
  if (raw.kind === 'day_before') {
    if (raw.clock) {
      const c = normHm(raw.clock);
      return c ? { kind: 'day_before', clock: c } : null;
    }
    return { kind: 'day_before' };
  }
  if (raw.kind === 'absolute' && allowAbsolute) {
    if (typeof raw.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw.at)) return null;
    return { kind: 'absolute', at: raw.at };
  }
  return null;
}

export function computeRemindAt(spec, anchor, s) {
  if (spec.kind === 'absolute') {
    const p = parseLocal(spec.at, s.timezone);
    return p ? p.date : null;
  }
  if (!anchor) return null;
  if (spec.kind === 'before') return new Date(anchor.getTime() - spec.minutes * 60000);
  if (spec.kind === 'day_before') {
    const day = addDaysYmd(ymdOf(anchor, s.timezone), -1);
    return atLocal(day, spec.clock || s.day_before_time, s.timezone);
  }
  return null;
}

export function replaceReminders(db, type, id, specs, anchor, s, now, { done = false } = {}) {
  db.prepare('DELETE FROM reminders WHERE item_type=? AND item_id=?').run(type, id);
  const ins = db.prepare(
    'INSERT INTO reminders (item_type,item_id,kind,minutes,clock,remind_at,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const seen = new Set();
  for (const raw of specs || []) {
    const spec = normalizeSpec(raw);
    if (!spec) continue;
    const at = computeRemindAt(spec, anchor, s);
    if (!at || seen.has(at.getTime())) continue;
    seen.add(at.getTime());
    // A reminder whose time has already passed is "skipped" rather than fired late.
    const status = !done && at > now ? 'pending' : 'skipped';
    ins.run(type, id, spec.kind, spec.minutes ?? null, spec.clock ?? null, at.toISOString(), status, now.toISOString());
  }
}

export function recomputeReminders(db, type, id, anchor, s, now, { done = false } = {}) {
  const rows = db.prepare("SELECT * FROM reminders WHERE item_type=? AND item_id=? AND status!='dismissed'").all(type, id);
  const upd = db.prepare('UPDATE reminders SET remind_at=?, status=?, fired_at=? WHERE id=?');
  for (const r of rows) {
    const at = r.kind === 'absolute'
      ? new Date(r.remind_at)
      : computeRemindAt({ kind: r.kind, minutes: r.minutes, clock: r.clock }, anchor, s);
    if (!at) continue;
    let status;
    if (done) status = r.status === 'fired' ? 'fired' : 'skipped';
    else if (at > now) status = 'pending';
    else status = r.status === 'fired' ? 'fired' : 'skipped';
    upd.run(at.toISOString(), status, status === 'pending' ? null : r.fired_at, r.id);
  }
}

export function recomputeAllPending(db, s, now) {
  const rows = db.prepare("SELECT * FROM reminders WHERE status='pending' AND kind!='absolute'").all();
  const task = db.prepare('SELECT due_at FROM tasks WHERE id=?');
  const meeting = db.prepare('SELECT start_at FROM meetings WHERE id=?');
  for (const r of rows) {
    const item = r.item_type === 'task' ? task.get(r.item_id) : meeting.get(r.item_id);
    const anchorIso = item && (item.due_at || item.start_at);
    if (!anchorIso) continue;
    recomputeReminders(db, r.item_type, r.item_id, new Date(anchorIso), s, now);
  }
}

export function loadReminders(db, type, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db
    .prepare(`SELECT * FROM reminders WHERE item_type=? AND item_id IN (${ids.map(() => '?').join(',')}) ORDER BY remind_at`)
    .all(type, ...ids);
  for (const r of rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, []);
    map.get(r.item_id).push(r);
  }
  return map;
}

export function reminderOut(r, s) {
  return {
    id: r.id, kind: r.kind, minutes: r.minutes, clock: r.clock,
    remind_at: r.remind_at, remind_local: localString(new Date(r.remind_at), s.timezone), status: r.status,
  };
}

export function dismissReminder(db, id) {
  return db.prepare("UPDATE reminders SET status='dismissed' WHERE id=?").run(id).changes > 0;
}

export function snoozeReminder(db, id, minutes, now) {
  const at = new Date(now.getTime() + minutes * 60000).toISOString();
  return db.prepare("UPDATE reminders SET kind='absolute', minutes=NULL, clock=NULL, remind_at=?, status='pending', fired_at=NULL WHERE id=?")
    .run(at, id).changes > 0;
}
