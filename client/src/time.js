// All formatting happens in the time zone chosen in Settings, not the browser's zone.

export const fmtTime = (iso, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const fmtDay = (iso, tz) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));

export const ymdIn = (tz, d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export const fmtYmd = (ymd, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(`${ymd}T12:00:00Z`));

export function relDay(ymd, tz, now = new Date()) {
  const today = ymdIn(tz, now);
  if (ymd === today) return 'Today';
  if (ymd === addDays(today, 1)) return 'Tomorrow';
  if (ymd === addDays(today, -1)) return 'Yesterday';
  return fmtYmd(ymd);
}

export function humanMin(m) {
  m = Math.max(0, Math.round(m || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function fmt12(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function addMinutesHm(hm, mins) {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.min(23 * 60 + 59, Math.max(0, h * 60 + m + mins));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export const diffMinutes = (a, b) => {
  const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
};

export function dueLabel(task, tz) {
  if (!task.due_at) return 'No due date';
  const day = relDay(task.due_local.slice(0, 10), tz);
  return task.due_has_time ? `${day}, ${fmtTime(task.due_at, tz)}` : day;
}

export function reminderLabel(spec, settings) {
  if (spec.kind === 'before') {
    const m = spec.minutes;
    if (m === 0) return 'At the time';
    if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'} before`;
    if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'} before`;
    return `${m} min before`;
  }
  if (spec.kind === 'day_before') return `Day before at ${fmt12(spec.clock || settings.day_before_time)}`;
  const [d, t] = String(spec.at).split('T');
  return `On ${fmtYmd(d)} at ${fmt12(t)}`;
}

// A reminder row from the server -> an editable spec
export const rowToSpec = (r) =>
  r.kind === 'absolute' ? { kind: 'absolute', at: r.remind_local }
    : r.kind === 'before' ? { kind: 'before', minutes: r.minutes }
      : { kind: 'day_before', ...(r.clock ? { clock: r.clock } : {}) };

export function greeting(tz) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
