// iCalendar feed (read-only). Subscribe to it from Google Calendar, Apple Calendar or Outlook.
const esc = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildIcs(db, now) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DayPilot//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:DayPilot'];
  const meetings = db.prepare("SELECT * FROM meetings WHERE status='scheduled' ORDER BY start_at").all();
  const remStmt = db.prepare("SELECT * FROM reminders WHERE item_type=? AND item_id=? AND status!='dismissed'");
  for (const m of meetings) {
    const attendees = JSON.parse(m.attendees || '[]');
    const desc = [m.notes, attendees.length ? `With: ${attendees.join(', ')}` : '', m.link ? `Link: ${m.link}` : ''].filter(Boolean).join('\n');
    L.push('BEGIN:VEVENT', `UID:meeting-${m.id}@daypilot`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(m.start_at)}`, `DTEND:${stamp(m.end_at)}`, `SUMMARY:${esc(m.title)}`);
    if (m.location) L.push(`LOCATION:${esc(m.location)}`);
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    if (m.link) L.push(`URL:${m.link}`);
    for (const r of remStmt.all('meeting', m.id)) {
      const mins = Math.round((new Date(m.start_at) - new Date(r.remind_at)) / 60000);
      if (mins >= 0) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(m.title)}`, `TRIGGER:-PT${mins}M`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  const tasks = db.prepare("SELECT * FROM tasks WHERE due_at IS NOT NULL ORDER BY due_at").all();
  for (const t of tasks) {
    L.push('BEGIN:VTODO', `UID:task-${t.id}@daypilot`, `DTSTAMP:${stamp(now)}`, `DUE:${stamp(t.due_at)}`, `SUMMARY:${esc(t.title)}`,
      `PRIORITY:${t.priority === 'high' ? 1 : t.priority === 'medium' ? 5 : 9}`, `STATUS:${t.status === 'done' ? 'COMPLETED' : 'NEEDS-ACTION'}`);
    if (t.description) L.push(`DESCRIPTION:${esc(t.description)}`);
    if (t.status === 'done' && t.completed_at) L.push(`COMPLETED:${stamp(t.completed_at)}`);
    L.push('END:VTODO');
  }
  L.push('END:VCALENDAR');
  return `${L.map(fold).join('\r\n')}\r\n`;
}
