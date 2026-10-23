import { dayRange, atLocal, addDaysYmd, ymdOf, weekdayOf } from './tz.js';
import { fmtTime, fmtDay, humanMinutes, plural } from './format.js';
import { tasksOut, meetingsOut } from './items.js';

const PRIORITY_SQL = "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";

function conflictsOf(meetings) {
  const out = [];
  const list = [...meetings].sort((a, b) => a.start_at.localeCompare(b.start_at));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].start_at < list[i].end_at) out.push({ a: list[i], b: list[j] });
    }
  }
  return out;
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, (Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 60000);
}

export function buildDay(ctx, ymd) {
  const { db, s, now } = ctx;
  const tz = s.timezone;
  const today = ymdOf(now, tz);
  const isToday = ymd === today;
  const { start, end } = dayRange(ymd, tz);
  const [a, b] = [start.toISOString(), end.toISOString()];

  const meetings = meetingsOut(ctx, db.prepare(
    "SELECT * FROM meetings WHERE status='scheduled' AND start_at < ? AND end_at > ? ORDER BY start_at",
  ).all(b, a));
  const due = tasksOut(ctx, db.prepare(
    `SELECT * FROM tasks WHERE status='open' AND due_at >= ? AND due_at < ? ORDER BY due_at, ${PRIORITY_SQL}`,
  ).all(a, b));
  const overdue = isToday
    ? tasksOut(ctx, db.prepare("SELECT * FROM tasks WHERE status='open' AND due_at < ? ORDER BY due_at").all(a))
    : [];
  const completed = tasksOut(ctx, db.prepare(
    "SELECT * FROM tasks WHERE status='done' AND completed_at >= ? AND completed_at < ? ORDER BY completed_at",
  ).all(a, b));

  const reminders = db.prepare(
    `SELECT r.*, COALESCE(t.title, m.title) AS title
       FROM reminders r
       LEFT JOIN tasks t ON r.item_type='task' AND t.id=r.item_id
       LEFT JOIN meetings m ON r.item_type='meeting' AND m.id=r.item_id
      WHERE r.status IN ('pending','fired') AND r.remind_at >= ? AND r.remind_at < ?
      ORDER BY r.remind_at`,
  ).all(a, b).map((r) => ({
    id: r.id, item_type: r.item_type, item_id: r.item_id, title: r.title, remind_at: r.remind_at, status: r.status,
  }));

  // Workload: working time left vs. meetings + estimated task time
  const ws = atLocal(ymd, s.work_start, tz), we = atLocal(ymd, s.work_end, tz);
  const from = isToday ? new Date(Math.max(now.getTime(), ws.getTime())) : ws;
  const isWorkDay = s.work_days.includes(weekdayOf(ymd));
  const capacity = isWorkDay && from < we ? Math.round((we - from) / 60000) : 0;
  const meetingMin = Math.round(meetings
    .filter((m) => m.phase !== 'past')
    .reduce((sum, m) => sum + overlapMinutes(new Date(m.start_at), new Date(m.end_at), from, we), 0));
  const taskMin = [...overdue, ...due].reduce((sum, t) => sum + (t.est_minutes || 0), 0);
  const free = Math.max(0, capacity - meetingMin);
  const workload = {
    capacity_min: capacity, meeting_min: meetingMin, task_min: taskMin, free_min: free,
    overbooked: taskMin > free && (taskMin > 0), work_day: isWorkDay,
  };

  // Priorities
  const rank = (t) => {
    if (t.risk?.level === 'overdue') return 0;
    if (t.priority === 'high') return 1;
    if (t.risk?.level === 'at_risk') return 1;
    return 2;
  };
  let pool = [...overdue, ...due];
  if (isToday) {
    const high = tasksOut(ctx, db.prepare(
      `SELECT * FROM tasks WHERE status='open' AND priority='high' AND (due_at IS NULL OR due_at >= ?) AND (due_at IS NULL OR due_at < ?) ORDER BY due_at`,
    ).all(b, addDaysYmdIso(ymd, 7, tz)));
    pool = [...pool, ...high];
  }
  const priorities = pool
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
    .sort((x, y) => rank(x) - rank(y) || String(x.due_at || '9').localeCompare(String(y.due_at || '9')))
    .slice(0, 5);

  // Alerts (today view): tasks overdue / at risk within the next 48h
  let atRisk = [];
  if (isToday) {
    const soon = new Date(now.getTime() + 48 * 3600000).toISOString();
    atRisk = tasksOut(ctx, db.prepare("SELECT * FROM tasks WHERE status='open' AND due_at IS NOT NULL AND due_at < ?").all(soon))
      .filter((t) => t.risk);
  }
  const conflicts = conflictsOf(meetings).map((c) => ({
    a: { id: c.a.id, title: c.a.title, start_at: c.a.start_at, end_at: c.a.end_at },
    b: { id: c.b.id, title: c.b.title, start_at: c.b.start_at, end_at: c.b.end_at },
  }));

  // Next up
  let nextUp = null;
  if (isToday) {
    const live = meetings.find((m) => m.phase === 'live');
    const nextMeeting = meetings.find((m) => m.phase === 'upcoming');
    const nextTask = due.find((t) => new Date(t.due_at) >= now);
    const candidates = [live && { type: 'meeting', item: live, at: live.start_at, live: true }]
      .concat([nextMeeting && { type: 'meeting', item: nextMeeting, at: nextMeeting.start_at }, nextTask && { type: 'task', item: nextTask, at: nextTask.due_at }])
      .filter(Boolean);
    if (live) nextUp = candidates[0];
    else nextUp = candidates.sort((x, y) => x.at.localeCompare(y.at))[0] || null;
    if (nextUp) nextUp = { type: nextUp.type, id: nextUp.item.id, title: nextUp.item.title, at: nextUp.at, live: Boolean(nextUp.live) };
  }

  return {
    date: ymd, is_today: isToday, now: now.toISOString(), meetings,
    tasks: { due, overdue, completed },
    priorities, reminders, alerts: { at_risk: atRisk, conflicts },
    workload, next_up: nextUp,
  };
}

function addDaysYmdIso(ymd, n, tz) {
  return atLocal(addDaysYmd(ymd, n), '00:00', tz).toISOString();
}

export function buildNextDay(ctx, ymd) {
  const day = buildDay(ctx, ymd);
  const { s, db } = ctx;
  const tz = s.timezone;
  const prep = [];
  for (const m of day.meetings) {
    if (m.prep) prep.push({ kind: 'prep', type: 'meeting', id: m.id, title: m.title, text: m.prep, at: m.start_at });
    else if (!m.notes && m.attendees.length >= 2) {
      prep.push({ kind: 'no_agenda', type: 'meeting', id: m.id, title: m.title, text: 'No agenda or prep notes yet', at: m.start_at });
    }
  }
  for (const t of day.tasks.due) {
    if (t.priority === 'high' && (t.est_minutes || 0) >= 60) {
      prep.push({ kind: 'block_time', type: 'task', id: t.id, title: t.title, text: `High priority — plan about ${humanMinutes(t.est_minutes)} for it`, at: t.due_at });
    }
    const early = atLocal(ymd, '11:00', tz);
    if (t.due_has_time && new Date(t.due_at) < early) {
      prep.push({ kind: 'due_early', type: 'task', id: t.id, title: t.title, text: `Due early (${fmtTime(new Date(t.due_at), tz)})`, at: t.due_at });
    }
  }
  prep.sort((x, y) => x.at.localeCompare(y.at));
  const review = db.prepare('SELECT reviewed_at FROM day_reviews WHERE date=?').get(ymd);
  const firstMeeting = day.meetings[0] || null;
  return { ...day, prep, reviewed_at: review ? review.reviewed_at : null, first_meeting: firstMeeting ? { id: firstMeeting.id, title: firstMeeting.title, start_at: firstMeeting.start_at } : null };
}

export function buildEndOfDay(ctx, ymd) {
  const { db, s } = ctx;
  const tz = s.timezone;
  const day = buildDay(ctx, ymd);
  const { end } = dayRange(ymd, tz);
  const pending = tasksOut(ctx, db.prepare(
    `SELECT * FROM tasks WHERE status='open' AND due_at < ? ORDER BY due_at, ${PRIORITY_SQL}`,
  ).all(end.toISOString()));
  const undated = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='open' AND due_at IS NULL").get().n;
  const afterTomorrow = atLocal(addDaysYmd(ymd, 2), '00:00', tz); // tomorrow itself is shown in its own section
  const soonEnd = atLocal(addDaysYmd(ymd, 5), '00:00', tz);
  const upcoming = tasksOut(ctx, db.prepare(
    `SELECT * FROM tasks WHERE status='open' AND due_at >= ? AND due_at < ? ORDER BY due_at`,
  ).all(afterTomorrow.toISOString(), soonEnd.toISOString()));
  const upcomingMeetings = meetingsOut(ctx, db.prepare(
    "SELECT * FROM meetings WHERE status='scheduled' AND start_at >= ? AND start_at < ? ORDER BY start_at",
  ).all(afterTomorrow.toISOString(), soonEnd.toISOString()));
  const tomorrow = buildNextDay(ctx, addDaysYmd(ymd, 1));
  const completed = day.tasks.completed;
  const completedMin = completed.reduce((sum, t) => sum + (t.est_minutes || 0), 0);
  const held = day.meetings;

  const summary = {
    date: ymd, now: ctx.now.toISOString(),
    completed, completed_minutes: completedMin,
    pending, undated_open: undated,
    meetings_held: held,
    upcoming_deadlines: upcoming,
    upcoming_meetings: upcomingMeetings,
    tomorrow,
    eod_time: s.eod_time,
  };
  summary.headline = headlineFor(summary, tz);
  summary.text = summaryText(summary, tz);
  return summary;
}

function headlineFor(sm, tz) {
  const done = sm.completed.length;
  const left = sm.pending.length;
  const tm = sm.tomorrow.meetings.length;
  const first = sm.tomorrow.first_meeting;
  return `${done} done, ${left} still pending. Tomorrow: ${plural(tm, 'meeting')}${first ? `, first at ${fmtTime(new Date(first.start_at), tz)}` : ''}.`;
}

function summaryText(sm, tz) {
  const lines = [];
  const t = (iso) => fmtTime(new Date(iso), tz);
  const dayLabel = fmtDay(atLocal(sm.date, '12:00', tz), tz);
  lines.push(`End-of-day summary — ${dayLabel}`, '');
  lines.push(`Completed (${sm.completed.length})${sm.completed_minutes ? ` — about ${humanMinutes(sm.completed_minutes)} of planned work` : ''}`);
  if (!sm.completed.length) lines.push('  (nothing marked complete today)');
  for (const x of sm.completed) lines.push(`  ✓ ${x.title}${x.project ? ` [${x.project}]` : ''}`);
  lines.push('', `Still pending (${sm.pending.length})`);
  if (!sm.pending.length) lines.push('  Nothing due or overdue — you are clear.');
  for (const x of sm.pending) {
    const flag = x.risk?.level === 'overdue' ? ' — OVERDUE' : '';
    lines.push(`  • ${x.title}${x.due_at ? ` (due ${fmtDay(new Date(x.due_at), tz)}${x.due_has_time ? ` ${t(x.due_at)}` : ''})` : ''}${flag}`);
  }
  if (sm.undated_open) lines.push(`  + ${plural(sm.undated_open, 'open task')} with no due date`);
  lines.push('', `Meetings (${sm.meetings_held.length})`);
  for (const x of sm.meetings_held) lines.push(`  • ${t(x.start_at)} ${x.title}`);
  if (!sm.meetings_held.length) lines.push('  (none)');
  lines.push('', 'Coming up after tomorrow (next 3 days)');
  if (!sm.upcoming_deadlines.length && !sm.upcoming_meetings.length) lines.push('  (no deadlines or meetings)');
  for (const x of sm.upcoming_deadlines) lines.push(`  • Due ${fmtDay(new Date(x.due_at), tz)}: ${x.title}`);
  for (const x of sm.upcoming_meetings) lines.push(`  • ${fmtDay(new Date(x.start_at), tz)} ${t(x.start_at)}: ${x.title}`);
  const tm = sm.tomorrow;
  lines.push('', `Tomorrow — ${fmtDay(atLocal(tm.date, '12:00', tz), tz)}`);
  if (!tm.meetings.length && !tm.tasks.due.length) lines.push('  Nothing scheduled yet.');
  for (const x of tm.meetings) lines.push(`  ${t(x.start_at)}–${t(x.end_at)} ${x.title}`);
  for (const x of tm.tasks.due) lines.push(`  Due ${x.due_has_time ? t(x.due_at) : 'today'}: ${x.title}`);
  if (tm.prep.length) {
    lines.push('  Prepare:');
    for (const x of tm.prep) lines.push(`   - ${x.title}: ${x.text}`);
  }
  return lines.join('\n');
}

// Message shown right after a task is marked complete.
export function completionUpdate(ctx, task) {
  const { db, s, now } = ctx;
  const tz = s.timezone;
  const today = ymdOf(now, tz);
  const { start, end } = dayRange(today, tz);
  const remainingRows = db.prepare("SELECT * FROM tasks WHERE status='open' AND due_at < ? ORDER BY due_at").all(end.toISOString());
  const remaining = tasksOut(ctx, remainingRows);
  const minutes = remaining.reduce((sum, t) => sum + (t.est_minutes || 0), 0);
  const doneToday = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='done' AND completed_at >= ? AND completed_at < ?")
    .get(start.toISOString(), end.toISOString()).n;
  const nextMeeting = db.prepare("SELECT * FROM meetings WHERE status='scheduled' AND start_at >= ? AND start_at < ? ORDER BY start_at LIMIT 1")
    .get(now.toISOString(), end.toISOString());
  let message = `Done: “${task.title}”. `;
  message += remaining.length === 0
    ? 'Nothing else is due today.'
    : `${plural(remaining.length, 'task')} left for today${minutes ? ` (about ${humanMinutes(minutes)})` : ''}. Next: “${remaining[0].title}”.`;
  if (nextMeeting) message += ` Next meeting: ${nextMeeting.title} at ${fmtTime(new Date(nextMeeting.start_at), tz)}.`;
  return {
    message, completed_today: doneToday, remaining_count: remaining.length, remaining_minutes: minutes,
    remaining: remaining.slice(0, 3).map((t) => ({ id: t.id, title: t.title, due_at: t.due_at })),
    next_meeting: nextMeeting ? { id: nextMeeting.id, title: nextMeeting.title, start_at: nextMeeting.start_at } : null,
  };
}
