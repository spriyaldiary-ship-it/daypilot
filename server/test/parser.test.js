import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture } from '../src/parser.js';
import { DEFAULT_SETTINGS } from '../src/db.js';
import { zonedToUtc, workingMinutes, ymdOf, localString } from '../src/tz.js';

// Monday 19 Oct 2026, 12:38 in Chennai
const now = new Date('2026-10-19T07:08:00Z');
const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
const parse = (t) => parseCapture(t, { now, settings });

test('time zones: Kolkata and DST-aware New York', () => {
  assert.equal(zonedToUtc(2026, 10, 20, 10, 0, 'Asia/Kolkata').toISOString(), '2026-10-20T04:30:00.000Z');
  assert.equal(zonedToUtc(2026, 10, 20, 12, 0, 'America/New_York').toISOString(), '2026-10-20T16:00:00.000Z');
  assert.equal(zonedToUtc(2026, 11, 2, 12, 0, 'America/New_York').toISOString(), '2026-11-02T17:00:00.000Z');
  assert.equal(ymdOf(now, 'Asia/Kolkata'), '2026-10-19');
  assert.equal(localString(now, 'Asia/Kolkata'), '2026-10-19T12:38');
});

test('working minutes skip nights and weekends', () => {
  const from = new Date('2026-10-23T11:30:00Z'); // Fri 17:00 IST
  const to = new Date('2026-10-26T04:30:00Z'); // Mon 10:00 IST
  assert.equal(workingMinutes(from, to, 'Asia/Kolkata', '09:00', '18:00', [1, 2, 3, 4, 5]), 60 + 60);
});

test('the example from the brief: "Call Payal tomorrow at 10 and remind me 15 minutes before"', () => {
  const r = parse('Call Payal tomorrow at 10 and remind me 15 minutes before.');
  assert.equal(r.kind, 'meeting');
  assert.equal(r.drafts.meeting.title, 'Call Payal');
  assert.equal(r.drafts.meeting.start, '2026-10-20T10:00');
  assert.equal(r.drafts.meeting.end, '2026-10-20T10:30');
  assert.deepEqual(r.drafts.meeting.attendees, ['Payal']);
  assert.deepEqual(r.drafts.meeting.reminders, [{ kind: 'before', minutes: 15 }]);
  assert.equal(r.reminders_from_text, true);
});

test('deadline words make a task with a due time, priority and project', () => {
  const r = parse('Submit GST report by Friday 5pm high priority #Admin');
  assert.equal(r.kind, 'task');
  assert.equal(r.drafts.task.title, 'Submit GST report');
  assert.equal(r.drafts.task.due, '2026-10-23T17:00');
  assert.equal(r.drafts.task.priority, 'high');
  assert.equal(r.drafts.task.project, 'Admin');
});

test('time ranges, multiple reminders', () => {
  const r = parse('Team sync 2-3pm tomorrow remind me a day before and 10 minutes before');
  assert.equal(r.kind, 'meeting');
  assert.equal(r.drafts.meeting.start, '2026-10-20T14:00');
  assert.equal(r.drafts.meeting.end, '2026-10-20T15:00');
  assert.deepEqual(r.drafts.meeting.reminders, [{ kind: 'before', minutes: 1440 }, { kind: 'before', minutes: 10 }]);
});

test('"remind me to ..." makes a task, with a reminder at the due time', () => {
  const r = parse('remind me to buy gifts on 25 oct');
  assert.equal(r.kind, 'task');
  assert.equal(r.drafts.task.title, 'Buy gifts');
  assert.equal(r.drafts.task.due, '2026-10-25');
});

test('relative hours and durations', () => {
  const r = parse('Follow up with leads in 2 hours');
  assert.equal(r.kind, 'task');
  assert.equal(r.drafts.task.due, '2026-10-19T14:38');
  const l = parse('Lunch with Ravi at 1pm for 45 minutes');
  assert.equal(l.kind, 'meeting');
  assert.equal(l.drafts.meeting.start, '2026-10-19T13:00');
  assert.equal(l.drafts.meeting.end, '2026-10-19T13:45');
  assert.deepEqual(l.drafts.meeting.attendees, ['Ravi']);
});

test('dd/mm dates and assumed afternoon hours are flagged', () => {
  const r = parse('Dentist 12/11 at 4');
  assert.equal(r.drafts.task.due, '2026-11-12T16:00');
  assert.ok(r.notes.some((n) => /day\/month/.test(n)));
  assert.ok(r.notes.some((n) => /Assumed 4:00 PM/.test(n)));
});

test('weekday resolution: this Friday vs next Friday vs next Monday', () => {
  assert.equal(parse('Report on Friday').drafts.task.due, '2026-10-23');
  assert.equal(parse('Report next Friday').drafts.task.due, '2026-10-30');
  assert.equal(parse('Report next Monday').drafts.task.due, '2026-10-26');
});

test('time already passed today moves to tomorrow with a note', () => {
  const r = parse('Water the plants at 9am');
  assert.equal(r.drafts.task.due, '2026-10-20T09:00');
  assert.ok(r.notes.some((n) => /tomorrow/.test(n)));
});

test('plain text becomes an undated task; empty input is rejected', () => {
  const r = parse('Buy printer paper');
  assert.equal(r.kind, 'task');
  assert.equal(r.drafts.task.due, null);
  assert.deepEqual(r.drafts.task.reminders, []);
  assert.throws(() => parse('   '), /Type something/);
});

test('explicit prefixes and meeting without time warn the user', () => {
  const r = parse('meeting: budget review tomorrow');
  assert.equal(r.kind, 'meeting');
  assert.equal(r.drafts.meeting.start, null);
  assert.ok(r.notes.some((n) => /start time/.test(n)));
});

test('default reminders come from settings when none are typed', () => {
  const r = parse('Call Ravi tomorrow at 11');
  assert.deepEqual(r.drafts.meeting.reminders, settings.default_meeting_reminders);
});
