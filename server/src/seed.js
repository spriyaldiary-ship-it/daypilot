import { addDaysYmd, ymdOf, dayRange } from './tz.js';
import { createTask, createMeeting, completeTask } from './items.js';

// Realistic sample data, placed relative to "today" so the dashboard always looks alive.
export function seedSample(db, s, now) {
  if (db.prepare('SELECT 1 FROM tasks WHERE is_sample=1 UNION SELECT 1 FROM meetings WHERE is_sample=1').get()) {
    return { skipped: true };
  }
  const tz = s.timezone;
  const today = ymdOf(now, tz);
  const L = (off, hm) => `${addDaysYmd(today, off)}T${hm}`;
  const D = (off) => addDaysYmd(today, off);
  const ctx = { db, s, now };
  const taskIds = [], meetingIds = [];
  const M = (m) => { const id = createMeeting(ctx, { ...m, force: true }).meeting.id; meetingIds.push(id); return id; };
  const T = (t) => { const id = createTask(ctx, { ...t, force: true }).task.id; taskIds.push(id); return id; };

  M({ title: 'Team stand-up', start: L(0, '10:00'), end: L(0, '10:15'), link: 'https://meet.example.com/standup', attendees: ['Ravi', 'Meena', 'Karthik'], notes: 'Quick round: yesterday, today, blockers.', project: 'Sales' });
  M({ title: 'Follow-up call with Payal', start: L(0, '14:30'), end: L(0, '15:15'), link: 'https://meet.example.com/payal', attendees: ['Payal'], prep: 'Open her last quote and bring the 3-month offer sheet.', notes: 'Wants to discuss renewal options.', project: 'Clients' });
  M({ title: 'Weekly sales review', start: L(0, '16:30'), end: L(0, '17:00'), location: 'Meeting room 1', attendees: ['Ravi', 'Meena', 'Divya'], notes: 'Agenda: new leads, conversions, targets for next week.', project: 'Sales' });
  M({ title: 'Monthly planning with branch team', start: L(1, '09:30'), end: L(1, '10:30'), location: 'Conference room', attendees: ['Ravi', 'Meena', 'Divya', 'Arun'], prep: "Print last month's numbers and list 3 blockers.", project: 'Sales' });
  M({ title: 'Vendor catch-up', start: L(1, '11:00'), end: L(1, '11:30'), link: 'https://meet.example.com/vendor', attendees: ['Suresh'], project: 'Admin' });
  M({ title: 'CRM training session', start: L(1, '15:00'), end: L(1, '16:00'), location: 'Training room', attendees: ['Divya', 'Arun', 'Meena'], project: 'Admin' });
  M({ title: 'Quarterly review with regional head', start: L(3, '11:00'), end: L(3, '12:00'), location: 'Head office', attendees: ['Regional head'], prep: 'Collect Q3 numbers, wins and issues.', project: 'Sales' });

  const done1 = T({ title: 'Send morning enquiry summary', due: L(0, '10:30'), priority: 'medium', est_minutes: 20, project: 'Sales' });
  const done2 = T({ title: 'Reply to pending WhatsApp leads', due: L(0, '12:00'), priority: 'high', est_minutes: 30, project: 'Sales' });
  T({ title: 'Submit expense claims', due: L(0, '13:30'), priority: 'medium', est_minutes: 60, project: 'Admin', description: 'Attach the scanned bills before submitting.' });
  T({ title: 'Update CRM pipeline', due: L(0, '15:00'), priority: 'high', est_minutes: 45, project: 'Sales' });
  T({ title: 'Prepare monthly sales report', due: L(0, '17:30'), priority: 'high', est_minutes: 90, project: 'Sales', description: 'Include conversion rate and top 5 lead sources.' });
  T({ title: 'Confirm vendor invoice', due: L(-1, '17:00'), priority: 'medium', est_minutes: 15, project: 'Admin' });
  T({ title: 'Share targets with the team', due: L(1, '10:00'), priority: 'high', est_minutes: 30, project: 'Sales' });
  T({ title: 'Review customer feedback forms', due: L(1, '16:00'), priority: 'low', est_minutes: 40, project: 'Clients' });
  T({ title: 'Draft festive offer plan', due: D(4), priority: 'medium', est_minutes: 120, project: 'Campaigns' });
  T({ title: 'Archive old leads', priority: 'low', project: 'Admin', reminders: [] });

  // Two tasks already finished earlier today
  const dayStart = dayRange(today, tz).start;
  const finish = (id, minutesAgo) => {
    completeTask(ctx, id);
    const at = new Date(Math.min(now.getTime(), Math.max(dayStart.getTime() + 5 * 60000, now.getTime() - minutesAgo * 60000))).toISOString();
    db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(at, id);
    db.prepare("UPDATE activity SET at=? WHERE item_type='task' AND item_id=? AND action='completed'").run(at, id);
  };
  finish(done1, 95);
  finish(done2, 40);

  const mark = (table, ids) => ids.forEach((id) => db.prepare(`UPDATE ${table} SET is_sample=1 WHERE id=?`).run(id));
  mark('tasks', taskIds);
  mark('meetings', meetingIds);
  return { tasks: taskIds.length, meetings: meetingIds.length };
}

export function clearSample(db) {
  const tasks = db.prepare('SELECT id FROM tasks WHERE is_sample=1').all().map((r) => r.id);
  const meetings = db.prepare('SELECT id FROM meetings WHERE is_sample=1').all().map((r) => r.id);
  for (const [type, ids, table] of [['task', tasks, 'tasks'], ['meeting', meetings, 'meetings']]) {
    for (const id of ids) {
      db.prepare('DELETE FROM reminders WHERE item_type=? AND item_id=?').run(type, id);
      db.prepare('DELETE FROM activity WHERE item_type=? AND item_id=?').run(type, id);
      db.prepare('DELETE FROM notifications WHERE ref_type=? AND ref_id=?').run(type, id);
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    }
  }
  return { tasks: tasks.length, meetings: meetings.length };
}
