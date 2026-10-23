// Rule-based natural-language quick capture. No AI service and no network: everything runs locally,
// so there are no keys to leak. The result is a *draft* the user can confirm or edit.
//
//   "Call Payal tomorrow at 10 and remind me 15 minutes before"
//   -> meeting, tomorrow 10:00-10:30, attendee Payal, reminder 15 min before

import { ymdOf, addDaysYmd, weekdayOf, parseYmd, atLocal, localString, parts } from './tz.js';
import { HttpError } from './errors.js';

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const NUM_RE = String.raw`\d+(?:\.\d+)?|half an?|half|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty`;
const UNIT_RE = String.raw`minutes?|mins?|min|hours?|hrs?|hr|days?|weeks?|h|m|d|w`;
const CLOCK = String.raw`(?:\d{1,2}(?::\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?))?|noon|midnight)`;
const LEAD = String.raw`(?:(?<![\w])(on|by|due(?:\s+on|\s+by)?|before|until|till|deadline\s*:?)\s+)?`;
const MEETING_WORDS = /\b(meeting|meet|call|sync|stand-?up|catch[- ]?up|interview|demo|1:1|one[- ]on[- ]one|lunch|dinner|coffee|session|webinar|appointment|consultation|huddle|workshop|training)\b/i;

const pad2 = (n) => String(n).padStart(2, '0');
const hm = (c) => `${pad2(c.h)}:${pad2(c.mi)}`;
const fmt12 = (c) => `${c.h % 12 || 12}:${pad2(c.mi)} ${c.h >= 12 ? 'PM' : 'AM'}`;

function numVal(w) {
  w = String(w).toLowerCase().trim();
  if (/^\d/.test(w)) return parseFloat(w);
  if (w === 'a' || w === 'an') return 1;
  if (w.startsWith('half')) return 0.5;
  return NUMW[w] ?? NaN;
}

function unitMinutes(u) {
  u = u.toLowerCase();
  if (/^(minutes?|mins?|min|m)$/.test(u)) return 1;
  if (/^(hours?|hrs?|hr|h)$/.test(u)) return 60;
  if (/^(days?|d)$/.test(u)) return 1440;
  return 10080;
}

function parseClock(raw) {
  const t = String(raw).trim().toLowerCase().replace(/\./g, '');
  if (t === 'noon') return { h: 12, mi: 0, mer: true };
  if (t === 'midnight') return { h: 0, mi: 0, mer: true };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = m[3] === 'am' ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
    return { h, mi, mer: true };
  }
  if (h > 23) return null;
  return { h, mi, mer: false };
}

// Hours 1-6 with no am/pm are assumed to be afternoon; 7-11 morning; 12 noon.
function assumeMeridiem(c) {
  if (c.mer || c.h >= 12 || c.h === 0 || c.h >= 7) return { h: c.h, mi: c.mi, assumedPm: false };
  return { h: c.h + 12, mi: c.mi, assumedPm: true };
}

function resolveRange(c1, c2) {
  const en = assumeMeridiem(c2);
  let st;
  if (!c1.mer && c2.mer) {
    const isPm = en.h >= 12;
    let h1 = c1.h;
    if (h1 < 12 && isPm) h1 += 12;
    if (h1 * 60 + c1.mi >= en.h * 60 + en.mi) h1 = c1.h === 12 ? 0 : c1.h;
    st = { h: h1, mi: c1.mi, assumedPm: false };
  } else {
    st = assumeMeridiem(c1);
  }
  return { st, en };
}

function extractReminders(s) {
  const m = /\bremind(?:\s+me)?\b/i.exec(s);
  if (!m) return { s, specs: [], mentioned: false };
  const start = m.index;
  let pos = m.index + m[0].length;
  const specs = [];
  const JOIN = String.raw`^\s*(?:,|and|&|\+)?\s*`;
  const before = new RegExp(`${JOIN}(?:about\\s+|around\\s+)?(${NUM_RE})\\s*(${UNIT_RE})(?![a-z])\\s*(?:before|prior|earlier|ahead)(?:\\s+(?:of\\s+)?(?:it|time|the\\s+(?:meeting|call|start|deadline)))?`, 'i');
  const dayBefore = new RegExp(`${JOIN}(?:the\\s+)?(?:day|night|evening)\\s+before(?:\\s+(?:at|around)\\s+(${CLOCK})(?!\\w))?`, 'i');
  const atTime = new RegExp(`${JOIN}(?:at|by)\\s+(${CLOCK})(?!\\w)`, 'i');
  for (;;) {
    const rest = s.slice(pos);
    let mm;
    if ((mm = before.exec(rest))) {
      specs.push({ kind: 'before', minutes: Math.round(numVal(mm[1]) * unitMinutes(mm[2])) });
    } else if ((mm = dayBefore.exec(rest))) {
      const spec = { kind: 'day_before' };
      const c = mm[1] && parseClock(mm[1]);
      if (c) spec.clock = hm(assumeMeridiem(c));
      specs.push(spec);
    } else if ((mm = atTime.exec(rest)) && parseClock(mm[1])) {
      specs.push({ kind: 'clock', clock: hm(assumeMeridiem(parseClock(mm[1]))) });
    } else break;
    pos += mm[0].length;
  }
  const cut = specs.length ? pos : start + m[0].length;
  return { s: `${s.slice(0, start)} ${s.slice(cut)}`, specs, mentioned: true };
}

function resolveWeekday(today, target, next) {
  const cur = weekdayOf(today);
  let delta = (target - cur + 7) % 7;
  if (next) {
    if (delta === 0) delta = 7;
    if (delta <= (7 - cur) % 7) delta += 7; // "next Fri" on a Wed means the Friday of next week
  }
  return addDaysYmd(today, delta);
}

function cleanTitle(str) {
  let t = str.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:please|pls|schedule|book|add|create|set up|setup|arrange)\s+(?:a\s+|an\s+)?/i, '');
  for (let i = 0; i < 4; i++) {
    t = t.replace(/[\s,.;:\-–—]+$/, '')
      .replace(/\s+(?:and|then|on|at|by|for|to|from|in|before|until|till|around|@|due)$/i, '')
      .replace(/^(?:and|then|,|;|-)\s+/i, '');
  }
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

const NOT_NAMES = new Set(['The', 'A', 'An', 'My', 'Our', 'Team', 'All', 'Everyone', 'Client', 'Customer', 'Vendor']);

function extractAttendees(title) {
  const m = /\b(?:[Ww]ith|[Cc]all|[Mm]eet)\s+([A-Z][\p{L}'’-]*(?:\s*(?:,|\band\b|&)\s*[A-Z][\p{L}'’-]*)*)/u.exec(title);
  if (!m) return [];
  return m[1].split(/\s*(?:,|\band\b|&)\s*/).map((x) => x.trim()).filter((x) => x && !NOT_NAMES.has(x));
}

export function parseCapture(input, { now, settings }) {
  const tz = settings.timezone;
  let text = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new HttpError(400, 'Type something to add, e.g. "Call Payal tomorrow at 10 and remind me 15 minutes before"');
  if (text.length > 500) throw new HttpError(400, 'That is too long for quick capture (max 500 characters). Use the full form instead.');
  const original = text;
  const notes = [];
  const today = ymdOf(now, tz);
  const nowP = parts(now, tz);
  const nowHm = `${pad2(nowP.h)}:${pad2(nowP.mi)}`;

  let forced = null;
  let reminderPrefix = false;
  let m;
  if ((m = /^(task|todo|to-do|meeting|mtg|event)\s*[:-]\s*/i.exec(text))) {
    forced = /^(task|todo|to-do)/i.test(m[1]) ? 'task' : 'meeting';
    text = text.slice(m[0].length);
  }
  if ((m = /^remind me (?:to|about)\s+/i.exec(text))) {
    reminderPrefix = true;
    forced = 'task';
    text = text.slice(m[0].length);
  }
  let s = ` ${text} `;

  // link
  let link = '';
  s = s.replace(/https?:\/\/[^\s)]+/i, (u) => { link = u.replace(/[.,;]+$/, ''); return ' '; });

  // reminders ("and remind me 15 minutes before")
  const rem = extractReminders(s);
  s = rem.s;

  // priority
  let priority = null;
  s = s.replace(
    /\b(high|medium|low|urgent|critical)\s+priority\b|\bpriority\s*(?:[:=]|is)?\s*(high|medium|low)\b|\b(urgent|asap)\b|!(high|medium|low)\b|\bp([123])\b/i,
    (_, a, b, c, d, e) => {
      const w = (a || b || c || d || '').toLowerCase();
      if (['high', 'urgent', 'critical', 'asap'].includes(w)) priority = 'high';
      else if (w === 'medium') priority = 'medium';
      else if (w === 'low') priority = 'low';
      else if (e) priority = e === '1' ? 'high' : e === '2' ? 'medium' : 'low';
      return ' ';
    },
  );

  // project (#name)
  let project = '';
  s = s.replace(/(^|\s)#([\p{L}\p{N}_-]+)/u, (_, pre, p) => { project = p.replace(/[-_]+/g, ' '); return pre; });

  // duration ("for 45 minutes", "takes 2 hours", "~30m")
  let durationMin = null;
  s = s.replace(new RegExp(`(?<![\\w])(?:for|takes?|taking|est(?:imated?)?\\.?|~)\\s*(${NUM_RE})\\s*(${UNIT_RE})(?![a-z])`, 'i'), (all, n, u) => {
    const v = Math.round(numVal(n) * unitMinutes(u));
    if (v >= 1 && v <= 1440) { durationMin = v; return ' '; }
    return all;
  });

  // time or time range
  let startC = null, endC = null, deadline = false, hasRange = false;
  const RANGE = new RegExp(`(?<![\\w:])(?:(from|between)\\s+)?(${CLOCK})\\s*(?:-|–|—|to|until|till|and)\\s*(${CLOCK})(?!\\w)`, 'i');
  const rm = RANGE.exec(s);
  if (rm) {
    const c1 = parseClock(rm[2]), c2 = parseClock(rm[3]);
    const plausible = c1 && c2 && (rm[1] || c1.mer || c2.mer || (rm[2].includes(':') && rm[3].includes(':')));
    if (plausible) {
      const r = resolveRange(c1, c2);
      if (r.st.h * 60 + r.st.mi < r.en.h * 60 + r.en.mi) {
        startC = r.st; endC = r.en; hasRange = true;
        if (r.st.assumedPm || r.en.assumedPm) notes.push(`Assumed ${fmt12(r.st)} to ${fmt12(r.en)}.`);
      } else {
        startC = assumeMeridiem(c1);
        notes.push('The end time was not after the start time, so it was ignored.');
      }
      s = `${s.slice(0, rm.index)} ${s.slice(rm.index + rm[0].length)}`;
    }
  }
  if (!startC) {
    const monthGuard = `(?!\\s*(?:${MONTH_RE}|st\\b|nd\\b|rd\\b|th\\b|/))`;
    const patterns = [
      [new RegExp(`(?<![\\w:])(at|@|by|before|around|until|till|from|due)\\s*(${CLOCK})(?!\\w)${monthGuard}`, 'i'), 2, 1],
      [/(?<![\w:])()(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))(?!\w)/i, 2, 1],
      [/(?<![\w:])()((?:[01]?\d|2[0-3]):[0-5]\d)(?!\w)/, 2, 1],
      [/\b()(noon|midnight)\b/i, 2, 1],
    ];
    for (const [re, g, lead] of patterns) {
      const mm = re.exec(s);
      if (!mm) continue;
      const c = parseClock(mm[g]);
      if (!c) continue;
      startC = assumeMeridiem(c);
      if (startC.assumedPm) notes.push(`Assumed ${fmt12(startC)} — change it if you meant AM.`);
      if (/^(by|before|until|till|due)$/i.test(mm[lead] || '')) deadline = true;
      s = `${s.slice(0, mm.index)} ${s.slice(mm.index + mm[0].length)}`;
      break;
    }
  }
  if (!startC && (m = /\b(eod|end of (?:the )?day|cob|close of business)\b/i.exec(s))) {
    const w = /^(\d\d):(\d\d)$/.exec(settings.work_end);
    startC = { h: +w[1], mi: +w[2] };
    deadline = true;
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  }

  // dates
  let date = null;
  let explicitToday = false;
  const take = (re, fn) => {
    const mm = re.exec(s);
    if (!mm) return false;
    const lead = mm[1] || '';
    const result = fn(mm);
    if (!result) return false;
    if (/^(by|due|before|until|till|deadline)/i.test(lead)) deadline = true;
    date = result;
    s = `${s.slice(0, mm.index)} ${s.slice(mm.index + mm[0].length)}`;
    return true;
  };
  const withYear = (mo, d, y) => {
    let year = y ? (+y < 100 ? 2000 + +y : +y) : +today.slice(0, 4);
    const candidate = () => `${year}-${pad2(mo)}-${pad2(d)}`;
    if (!parseYmd(candidate())) return null;
    if (!y && candidate() < today) { year += 1; notes.push(`No year given, so ${candidate()} was used.`); }
    return parseYmd(candidate()) ? candidate() : null;
  };

  let found =
    take(new RegExp(`${LEAD}(?<![\\w-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\w-])`, 'i'), (mm) => (parseYmd(`${mm[2]}-${mm[3]}-${mm[4]}`) ? `${mm[2]}-${mm[3]}-${mm[4]}` : null)) ||
    take(new RegExp(`${LEAD}(?<![\\w/])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?!\\w)(?:,?\\s*(\\d{4}))?`, 'i'), (mm) => withYear(MONTHS[mm[3].toLowerCase()], +mm[2], mm[4])) ||
    take(new RegExp(`${LEAD}(?<!\\w)(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\w)(?:,?\\s*(\\d{4})(?!\\d))?`, 'i'), (mm) => withYear(MONTHS[mm[2].toLowerCase()], +mm[3], mm[4])) ||
    take(new RegExp(`${LEAD}(?<![\\w/])(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?(?![\\w/])`, 'i'), (mm) => {
      let d = +mm[2], mo = +mm[3];
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      notes.push('Read the date as day/month.');
      return withYear(mo, d, mm[4]);
    });

  if (!found) {
    found =
      take(new RegExp(`${LEAD}\\b(day after tomorrow|overmorrow)\\b`, 'i'), () => addDaysYmd(today, 2)) ||
      take(new RegExp(`${LEAD}\\b(tomorrow|tmrw|tmr)\\b`, 'i'), () => addDaysYmd(today, 1)) ||
      take(new RegExp(`${LEAD}\\b(today)\\b`, 'i'), () => { explicitToday = true; return today; }) ||
      take(new RegExp(`${LEAD}\\bin\\s+(${NUM_RE})\\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)(?![a-z])`, 'i'), (mm) => {
        const n = numVal(mm[2]);
        const unit = unitMinutes(mm[3]);
        if (!(n > 0)) return null;
        if (unit < 1440) {
          const at = new Date(Math.ceil((now.getTime() + n * unit * 60000) / 60000) * 60000);
          const p = parts(at, tz);
          startC = { h: p.h, mi: p.mi };
          return ymdOf(at, tz);
        }
        return addDaysYmd(today, Math.round((n * unit) / 1440));
      }) ||
      take(new RegExp(`${LEAD}(?<![\\w])(?:(next|this|coming)\\s+)?(${DAY_RE})(?![\\w])`, 'i'), (mm) => {
        let d = resolveWeekday(today, WEEKDAYS[mm[3].toLowerCase()], /^next$/i.test(mm[2] || ''));
        if (d === today && startC && hm(startC) <= nowHm && !/^(this)$/i.test(mm[2] || '')) {
          d = addDaysYmd(today, 7);
          notes.push('That time has already passed today, so next week was used.');
        }
        return d;
      }) ||
      take(new RegExp(`${LEAD}\\b(eow|end of (?:the )?week)\\b`, 'i'), () => {
        const cur = weekdayOf(today);
        return addDaysYmd(today, cur === 6 ? 6 : cur === 0 ? 5 : 5 - cur);
      }) ||
      take(new RegExp(`${LEAD}\\b(eom|end of (?:the )?month)\\b`, 'i'), () => {
        const [y, mo] = today.split('-').map(Number);
        return `${y}-${pad2(mo)}-${pad2(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
      }) ||
      take(new RegExp(`${LEAD}\\bnext week\\b`, 'i'), () => addDaysYmd(today, ((8 - weekdayOf(today)) % 7) || 7)) ||
      take(new RegExp(`${LEAD}\\bthis weekend\\b`, 'i'), () => addDaysYmd(today, (6 - weekdayOf(today) + 7) % 7)) ||
      take(new RegExp(`${LEAD}(?:\\bon\\s+the\\s+|\\bthe\\s+)?(?<![\\w])(\\d{1,2})(?:st|nd|rd|th)(?![\\w])`, 'i'), (mm) => {
        const dayNum = +mm[2];
        let [y, mo] = today.split('-').map(Number);
        const ymd = (yy, mm2) => `${yy}-${pad2(mm2)}-${pad2(dayNum)}`;
        if (parseYmd(ymd(y, mo)) && ymd(y, mo) >= today) return ymd(y, mo);
        mo += 1;
        if (mo > 12) { mo = 1; y += 1; }
        return parseYmd(ymd(y, mo)) ? ymd(y, mo) : null;
      });
  }

  // parts of the day, only when no explicit time was given
  if (!startC) {
    const pod = { morning: '09:00', afternoon: '14:00', evening: '18:00' };
    let mm;
    if ((mm = /\btonight\b/i.exec(s))) {
      startC = { h: 20, mi: 0 };
      if (!date) { date = today; explicitToday = true; }
      s = `${s.slice(0, mm.index)} ${s.slice(mm.index + mm[0].length)}`;
      notes.push('"Tonight" was read as 8:00 PM.');
    } else if ((mm = /\bthis\s+(morning|afternoon|evening)\b/i.exec(s))) {
      const t = pod[mm[1].toLowerCase()].split(':').map(Number);
      startC = { h: t[0], mi: 0 };
      if (!date) { date = today; explicitToday = true; }
      s = `${s.slice(0, mm.index)} ${s.slice(mm.index + mm[0].length)}`;
      notes.push(`"${mm[1]}" was read as ${fmt12(startC)}.`);
    } else if (found && (mm = /\b(morning|afternoon|evening)\b/i.exec(s)) && new RegExp(`(?:today|tomorrow|tmrw|tmr|${DAY_RE})\\s+${mm[1]}\\b`, 'i').test(original)) {
      const t = pod[mm[1].toLowerCase()].split(':').map(Number);
      startC = { h: t[0], mi: 0 };
      s = `${s.slice(0, mm.index)} ${s.slice(mm.index + mm[0].length)}`;
      notes.push(`"${mm[1]}" was read as ${fmt12(startC)}.`);
    }
  }

  // time without a date -> today if still ahead, otherwise tomorrow
  if (startC && !date) {
    if (hm(startC) > nowHm) date = today;
    else { date = addDaysYmd(today, 1); notes.push('That time has already passed today, so tomorrow was used.'); }
  }
  if (date && date < today) notes.push('That date is in the past — check it before saving.');

  // kind
  let title = cleanTitle(s);
  if (!title) throw new HttpError(400, 'I could not find a title. Try "Call Payal tomorrow at 10".');
  const wantsMeeting = hasRange || (startC && MEETING_WORDS.test(title) && !deadline) || (startC && /^\s*(schedule|book|set up|arrange)\b/i.test(original));
  const kind = forced || (wantsMeeting ? 'meeting' : 'task');
  if (!forced && kind === 'meeting') notes.push('Added as a meeting because it has a start time. Switch to Task if that is wrong.');

  // meeting extras
  const attendees = extractAttendees(title);
  let location = '';
  let meetingTitle = title;
  const lm = /\s+(?:at|in)\s+((?:the\s+)?[A-Z][\w&'’-]*(?:\s+[A-Z0-9][\w&'’-]*)*)\s*$/.exec(title);
  if (lm) { location = lm[1]; meetingTitle = cleanTitle(title.slice(0, lm.index)); }

  const dueLocal = date ? (startC ? `${date}T${hm(startC)}` : date) : null;
  let startLocal = null, endLocal = null;
  if (date && startC) {
    startLocal = `${date}T${hm(startC)}`;
    if (endC) endLocal = `${date}T${hm(endC)}`;
    else {
      const mins = durationMin || settings.default_meeting_minutes;
      const startUtc = atLocal(date, hm(startC), tz);
      endLocal = localString(new Date(startUtc.getTime() + mins * 60000), tz);
    }
  } else if (kind === 'meeting') {
    notes.push('A meeting needs a start time — add one before saving.');
  }

  const reminderFor = (anchorLocal, which) => {
    if (rem.specs.length) {
      if (!anchorLocal && rem.specs.some((x) => x.kind !== 'clock')) {
        notes.push('Reminders like "15 minutes before" need a date and time, so they were not added.');
      }
      const out = [];
      for (const sp of rem.specs) {
        if (sp.kind === 'clock') {
          const base = anchorLocal ? anchorLocal.slice(0, 10) : today;
          let at = `${base}T${sp.clock}`;
          if (anchorLocal && anchorLocal.length > 10 && at > anchorLocal) at = `${addDaysYmd(base, -1)}T${sp.clock}`;
          if (!anchorLocal && at <= `${today}T${nowHm}`) at = `${addDaysYmd(today, 1)}T${sp.clock}`;
          out.push({ kind: 'absolute', at });
        } else if (anchorLocal) out.push(sp);
      }
      return out;
    }
    if (reminderPrefix && anchorLocal) return [{ kind: 'before', minutes: 0 }];
    if (!anchorLocal) return [];
    return which === 'task' ? settings.default_task_reminders : settings.default_meeting_reminders;
  };

  if (rem.mentioned && !rem.specs.length) notes.push('I could not understand the reminder wording, so default reminders were used.');

  return {
    original,
    kind,
    reminders_from_text: rem.specs.length > 0,
    notes,
    drafts: {
      task: {
        title,
        description: link ? `Link: ${link}` : '',
        due: dueLocal,
        priority: priority || 'medium',
        est_minutes: durationMin,
        project,
        reminders: reminderFor(dueLocal, 'task'),
      },
      meeting: {
        title: meetingTitle,
        start: startLocal,
        end: endLocal,
        location,
        link,
        attendees,
        notes: '',
        prep: '',
        project,
        reminders: reminderFor(startLocal, 'meeting'),
      },
    },
  };
}
