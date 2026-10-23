import { ymdOf, addDaysYmd } from './tz.js';

const STOP = new Set(['the', 'a', 'an', 'to', 'with', 'for', 'and', 'of', 'on', 'at', 'my', 'our', 'up', 'in']);

export function tokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

export function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const contained = inter === Math.min(A.size, B.size) && Math.min(A.size, B.size) >= 2;
  return Math.max(jaccard, contained ? 0.85 : 0);
}

const THRESHOLD = 0.7;

export function findTaskDuplicates(db, task, s) {
  const rows = db.prepare("SELECT * FROM tasks WHERE status='open'").all();
  return rows
    .filter((r) => similarity(r.title, task.title) >= THRESHOLD)
    .filter((r) => {
      if (!r.due_at || !task.due_at) return true;
      const a = ymdOf(new Date(r.due_at), s.timezone), b = ymdOf(new Date(task.due_at), s.timezone);
      return a === b || addDaysYmd(a, 1) === b || addDaysYmd(b, 1) === a;
    })
    .slice(0, 3);
}

export function findMeetingDuplicates(db, meeting, s, excludeId = null) {
  const day = ymdOf(new Date(meeting.start_at), s.timezone);
  const rows = db.prepare("SELECT * FROM meetings WHERE status='scheduled'").all();
  return rows
    .filter((r) => r.id !== excludeId)
    .filter((r) => ymdOf(new Date(r.start_at), s.timezone) === day)
    .filter((r) => similarity(r.title, meeting.title) >= THRESHOLD)
    .slice(0, 3);
}
