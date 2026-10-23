// Time-zone helpers built on Intl only (no dependencies).
// All instants are stored as UTC ISO strings; "local" strings are wall-clock
// values in the user's chosen time zone: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm".

const cache = new Map();
function dtf(tz) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    cache.set(tz, f);
  }
  return f;
}

const pad = (n) => String(n).padStart(2, '0');

export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function parts(date, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(date)) if (p.type !== 'literal') o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

export function offsetMinutes(date, tz) {
  const p = parts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  const t = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - t) / 60000);
}

export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMinutes(new Date(guess), tz);
  let utc = guess - off1 * 60000;
  const off2 = offsetMinutes(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2 * 60000;
  return new Date(utc);
}

export function ymdOf(date, tz) {
  const p = parts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function localString(date, tz) {
  const p = parts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

export function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function addDaysYmd(s, n) {
  const { y, m, d } = parseYmd(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function weekdayOf(s) { // 0 = Sunday
  const { y, m, d } = parseYmd(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function parseHm(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? { h: +m[1], mi: +m[2] } : null;
}

export function normHm(s) {
  const p = parseHm(s);
  return p ? `${pad(p.h)}:${pad(p.mi)}` : null;
}

export function atLocal(ymd, hm, tz) {
  const p = parseYmd(ymd), t = parseHm(hm);
  return zonedToUtc(p.y, p.m, p.d, t.h, t.mi, tz);
}

// "2026-10-20" or "2026-10-20T10:00" -> { date: Date, hasTime }
export function parseLocal(str, tz, { defaultHm = '00:00' } = {}) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(String(str || '').trim());
  if (!m) return null;
  const ymd = parseYmd(m[1]);
  const hm = parseHm(m[2] || defaultHm);
  if (!ymd || !hm) return null;
  return { date: zonedToUtc(ymd.y, ymd.m, ymd.d, hm.h, hm.mi, tz), hasTime: Boolean(m[2]) };
}

export function dayRange(ymd, tz) {
  return { start: atLocal(ymd, '00:00', tz), end: atLocal(addDaysYmd(ymd, 1), '00:00', tz) };
}

// Minutes inside working hours between two instants (skips non-work days).
export function workingMinutes(from, to, tz, startHm, endHm, workDays = [1, 2, 3, 4, 5]) {
  if (to <= from) return 0;
  let day = ymdOf(from, tz);
  const last = ymdOf(to, tz);
  let total = 0;
  for (let i = 0; i < 400; i++) {
    if (workDays.includes(weekdayOf(day))) {
      const ws = atLocal(day, startHm, tz), we = atLocal(day, endHm, tz);
      const s = Math.max(ws.getTime(), from.getTime());
      const e = Math.min(we.getTime(), to.getTime());
      if (e > s) total += (e - s) / 60000;
    }
    if (day >= last) break;
    day = addDaysYmd(day, 1);
  }
  return Math.round(total);
}
