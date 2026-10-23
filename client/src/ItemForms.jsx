import { useId, useState } from 'react';
import { api } from './api.js';
import { useApp } from './ctx.js';
import { Badge, Field, Modal } from './ui.jsx';
import { addMinutesHm, diffMinutes, dueLabel, fmtDay, fmtTime, reminderLabel, rowToSpec } from './time.js';

/* ---------------------------- reminder editor ---------------------------- */

const PRESETS = [
  { label: 'At the time', spec: { kind: 'before', minutes: 0 } },
  { label: '5 minutes before', spec: { kind: 'before', minutes: 5 } },
  { label: '15 minutes before', spec: { kind: 'before', minutes: 15 } },
  { label: '30 minutes before', spec: { kind: 'before', minutes: 30 } },
  { label: '1 hour before', spec: { kind: 'before', minutes: 60 } },
  { label: '2 hours before', spec: { kind: 'before', minutes: 120 } },
  { label: 'Evening before (your preferred time)', spec: { kind: 'day_before' } },
  { label: '1 day before', spec: { kind: 'before', minutes: 1440 } },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function ReminderEditor({ value, onChange, hasAnchor, anchorWord, allowAbsolute = true, legend = 'Reminders' }) {
  const { settings } = useApp();
  const uid = useId();
  const [mode, setMode] = useState('');
  const [custom, setCustom] = useState({ n: 20, unit: 1 });
  const [abs, setAbs] = useState({ date: '', time: '09:00' });

  const add = (spec) => { if (!value.some((v) => same(v, spec))) onChange([...value, spec]); };

  return (
    <fieldset className="reminders">
      <legend>{legend}</legend>
      {value.length === 0 && <p className="muted small">No reminders. You will not be notified about this item.</p>}
      <ul className="chips">
        {value.map((spec, i) => (
          <li key={i} className="chip">
            {reminderLabel(spec, settings)}
            <button type="button" aria-label={`Remove reminder: ${reminderLabel(spec, settings)}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ul>
      {!hasAnchor && <p className="muted small">Add a {anchorWord} to use “before” reminders. You can still set a specific time.</p>}
      <div className="row wrap">
        <label className="sr-only" htmlFor={`${uid}-add`}>Add a reminder</label>
        <select
          id={`${uid}-add`}
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom' || v === 'absolute') { setMode(v); return; }
            if (v !== '') add(PRESETS[Number(v)].spec);
          }}
        >
          <option value="">+ Add a reminder…</option>
          {hasAnchor && PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
          {hasAnchor && <option value="custom">Custom time before…</option>}
          {allowAbsolute && <option value="absolute">At a specific date and time…</option>}
        </select>
      </div>
      {mode === 'custom' && (
        <div className="row wrap inline-form">
          <label className="sr-only" htmlFor={`${uid}-n`}>Amount</label>
          <input id={`${uid}-n`} type="number" min="1" max="999" value={custom.n} onChange={(e) => setCustom({ ...custom, n: e.target.value })} style={{ width: 80 }} />
          <label className="sr-only" htmlFor={`${uid}-u`}>Unit</label>
          <select id={`${uid}-u`} value={custom.unit} onChange={(e) => setCustom({ ...custom, unit: Number(e.target.value) })}>
            <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
          </select>
          <span>before</span>
          <button type="button" className="btn btn-small" onClick={() => {
            const m = Math.round(Number(custom.n) * custom.unit);
            if (m >= 0 && m <= 43200) { add({ kind: 'before', minutes: m }); setMode(''); }
          }}>Add</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setMode('')}>Cancel</button>
        </div>
      )}
      {mode === 'absolute' && (
        <div className="row wrap inline-form">
          <label className="sr-only" htmlFor={`${uid}-d`}>Reminder date</label>
          <input id={`${uid}-d`} type="date" value={abs.date} onChange={(e) => setAbs({ ...abs, date: e.target.value })} />
          <label className="sr-only" htmlFor={`${uid}-t`}>Reminder time</label>
          <input id={`${uid}-t`} type="time" value={abs.time} onChange={(e) => setAbs({ ...abs, time: e.target.value })} />
          <button type="button" className="btn btn-small" disabled={!abs.date || !abs.time} onClick={() => { add({ kind: 'absolute', at: `${abs.date}T${abs.time}` }); setMode(''); }}>Add</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setMode('')}>Cancel</button>
        </div>
      )}
    </fieldset>
  );
}

/* ----------------------------- duplicate dialog ----------------------------- */

export function DuplicateDialog({ type, duplicates, onForce, onCancel }) {
  const { settings } = useApp();
  const tz = settings.timezone;
  return (
    <Modal title={`Possible duplicate ${type}`} onClose={onCancel} role="alertdialog">
      <p>This looks similar to something you already have:</p>
      <ul className="dupe-list">
        {duplicates.map((d) => (
          <li key={`${d.type}-${d.id}`}>
            <strong>{d.title}</strong>
            <span className="muted small">
              {d.type === 'task' ? dueLabel(d, tz) : `${fmtDay(d.start_at, tz)}, ${fmtTime(d.start_at, tz)}`}
            </span>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onCancel}>Don’t add (keep existing)</button>
        <button className="btn" onClick={onForce}>Add it anyway</button>
      </div>
    </Modal>
  );
}

/* --------------------------------- forms --------------------------------- */

function useSaver({ onClose }) {
  const { bump, toast } = useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [dupes, setDupes] = useState(null);
  return { saving, setSaving, error, setError, dupes, setDupes, bump, toast, onClose };
}

const fieldError = (error, name) => (error && error.field === name ? error.message : null);

export function TaskForm({ initial, draft, onClose }) {
  const { settings } = useApp();
  const sv = useSaver({ onClose });
  const editing = Boolean(initial && initial.id);
  const src = initial || draft || {};
  const dueLocal = initial ? initial.due_local : draft?.due || null;
  const [title, setTitle] = useState(src.title || '');
  const [description, setDescription] = useState(src.description || '');
  const [date, setDate] = useState(dueLocal ? dueLocal.slice(0, 10) : '');
  const [time, setTime] = useState(dueLocal && dueLocal.length > 10 ? dueLocal.slice(11, 16) : '');
  const [priority, setPriority] = useState(src.priority || 'medium');
  const [est, setEst] = useState(src.est_minutes || '');
  const [project, setProject] = useState(src.project || '');
  const [reminders, setReminders] = useState(
    initial ? initial.reminders.filter((r) => r.status !== 'dismissed').map(rowToSpec) : draft?.reminders ?? settings.default_task_reminders,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const body = () => ({
    title, description, due: date ? (time ? `${date}T${time}` : date) : null, priority,
    est_minutes: est === '' ? null : Number(est), project, reminders,
  });

  async function save(force = false) {
    sv.setSaving(true); sv.setError(null);
    try {
      if (editing) await api.patch(`/tasks/${initial.id}`, body());
      else await api.post('/tasks', { ...body(), force });
      sv.toast({ message: editing ? 'Task saved.' : 'Task added.', tone: 'success' });
      sv.bump(); onClose();
    } catch (e) {
      if (e.code === 'duplicate') sv.setDupes(e.duplicates); else sv.setError(e);
    } finally { sv.setSaving(false); }
  }

  async function remove() {
    try { await api.del(`/tasks/${initial.id}`); sv.toast({ message: 'Task deleted.' }); sv.bump(); onClose(); } catch (e) { sv.setError(e); }
  }

  return (
    <Modal title={editing ? 'Edit task' : 'New task'} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
        <Field label="Title" error={fieldError(sv.error, 'title')}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </Field>
        <Field label="Description (optional)" error={fieldError(sv.error, 'description')}>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <div className="grid2">
          <Field label="Due date" error={fieldError(sv.error, 'due')}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Due time (optional)" hint={date ? 'Leave empty for end of your working day' : 'Pick a date first'}>
            <input type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <div className="grid3">
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
          </Field>
          <Field label="Estimated minutes" error={fieldError(sv.error, 'estimate')}>
            <input type="number" min="1" max="1440" value={est} onChange={(e) => setEst(e.target.value)} placeholder="e.g. 45" />
          </Field>
          <Field label="Project or category" error={fieldError(sv.error, 'project')}>
            <input value={project} onChange={(e) => setProject(e.target.value)} maxLength={60} list="project-list" placeholder="e.g. Sales" />
          </Field>
        </div>
        <ReminderEditor value={reminders} onChange={setReminders} hasAnchor={Boolean(date)} anchorWord="due date" />
        {sv.error && !sv.error.field && <div className="alert alert-danger" role="alert">{sv.error.message}</div>}
        <div className="modal-actions">
          {editing && (confirmDelete
            ? <button type="button" className="btn btn-danger" onClick={remove}>Yes, delete</button>
            : <button type="button" className="btn btn-ghost-danger" onClick={() => setConfirmDelete(true)}>Delete</button>)}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={sv.saving}>{sv.saving ? 'Saving…' : editing ? 'Save changes' : 'Add task'}</button>
        </div>
      </form>
      {sv.dupes && <DuplicateDialog type="task" duplicates={sv.dupes} onCancel={() => { sv.setDupes(null); onClose(); }} onForce={() => { sv.setDupes(null); save(true); }} />}
    </Modal>
  );
}

export function MeetingForm({ initial, draft, onClose }) {
  const { settings } = useApp();
  const sv = useSaver({ onClose });
  const editing = Boolean(initial && initial.id);
  const src = initial || draft || {};
  const startLocal = initial ? initial.start_local : draft?.start || '';
  const endLocal = initial ? initial.end_local : draft?.end || '';
  const [title, setTitle] = useState(src.title || '');
  const [date, setDate] = useState(startLocal ? startLocal.slice(0, 10) : '');
  const [start, setStart] = useState(startLocal ? startLocal.slice(11, 16) : '');
  const [end, setEnd] = useState(endLocal ? endLocal.slice(11, 16) : '');
  const [location, setLocation] = useState(src.location || '');
  const [link, setLink] = useState(src.link || '');
  const [attendees, setAttendees] = useState((src.attendees || []).join(', '));
  const [notes, setNotes] = useState(src.notes || '');
  const [prep, setPrep] = useState(src.prep || '');
  const [project, setProject] = useState(src.project || '');
  const [reminders, setReminders] = useState(
    initial ? initial.reminders.filter((r) => r.status !== 'dismissed').map(rowToSpec) : draft?.reminders ?? settings.default_meeting_reminders,
  );
  const [clientError, setClientError] = useState('');

  const onStart = (v) => {
    const duration = start && end ? diffMinutes(start, end) : settings.default_meeting_minutes;
    setStart(v);
    if (v && (!end || diffMinutes(v, end) <= 0 || start)) setEnd(addMinutesHm(v, duration > 0 ? duration : settings.default_meeting_minutes));
  };

  const body = () => ({
    title, start: `${date}T${start}`, end: end ? `${date}T${end}` : null, location, link,
    attendees: attendees.split(',').map((a) => a.trim()).filter(Boolean), notes, prep, project, reminders,
  });

  async function save(force = false) {
    setClientError('');
    if (!date || !start) { setClientError('Pick a date and a start time.'); return; }
    sv.setSaving(true); sv.setError(null);
    try {
      const r = editing ? await api.patch(`/meetings/${initial.id}`, body()) : await api.post('/meetings', { ...body(), force });
      sv.toast({ message: `${editing ? 'Meeting saved.' : 'Meeting added.'}${r.warnings?.length ? ` Heads up: ${r.warnings.join('; ')}.` : ''}`, tone: r.warnings?.length ? 'warn' : 'success', ms: 7000 });
      sv.bump(); onClose();
    } catch (e) {
      if (e.code === 'duplicate') sv.setDupes(e.duplicates); else sv.setError(e);
    } finally { sv.setSaving(false); }
  }

  async function setStatus(status) {
    try { await api.patch(`/meetings/${initial.id}`, { status }); sv.toast({ message: status === 'cancelled' ? 'Meeting cancelled. Its reminders are off.' : 'Meeting restored.' }); sv.bump(); onClose(); } catch (e) { sv.setError(e); }
  }

  const [confirmDelete, setConfirmDelete] = useState(false);
  async function remove() {
    try { await api.del(`/meetings/${initial.id}`); sv.toast({ message: 'Meeting deleted.' }); sv.bump(); onClose(); } catch (e) { sv.setError(e); }
  }

  return (
    <Modal title={editing ? 'Edit meeting' : 'New meeting'} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
        {editing && initial.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
        <Field label="Title" error={fieldError(sv.error, 'title')}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </Field>
        <div className="grid3">
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label="Start time" error={fieldError(sv.error, 'start')}><input type="time" value={start} onChange={(e) => onStart(e.target.value)} required /></Field>
          <Field label="End time" error={fieldError(sv.error, 'end')} hint={`Default ${settings.default_meeting_minutes} min`}><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <div className="grid2">
          <Field label="Location (optional)"><input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} placeholder="Room, address…" /></Field>
          <Field label="Video link (optional)" error={fieldError(sv.error, 'link')}><input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" /></Field>
        </div>
        <Field label="People attending" hint="Separate names with commas"><input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Payal, Ravi" /></Field>
        <Field label="Notes (optional)"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></Field>
        <div className="grid2">
          <Field label="What to prepare (shown in tomorrow’s review)"><input value={prep} onChange={(e) => setPrep(e.target.value)} maxLength={2000} placeholder="e.g. Print last month’s numbers" /></Field>
          <Field label="Project or category"><input value={project} onChange={(e) => setProject(e.target.value)} maxLength={60} list="project-list" /></Field>
        </div>
        <ReminderEditor value={reminders} onChange={setReminders} hasAnchor anchorWord="start time" />
        {(clientError || (sv.error && !sv.error.field)) && <div className="alert alert-danger" role="alert">{clientError || sv.error.message}</div>}
        <div className="modal-actions">
          {editing && (initial.status === 'cancelled'
            ? <button type="button" className="btn" onClick={() => setStatus('scheduled')}>Restore</button>
            : <button type="button" className="btn btn-ghost" onClick={() => setStatus('cancelled')}>Cancel meeting</button>)}
          {editing && (confirmDelete
            ? <button type="button" className="btn btn-danger" onClick={remove}>Yes, delete</button>
            : <button type="button" className="btn btn-ghost-danger" onClick={() => setConfirmDelete(true)}>Delete</button>)}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={sv.saving}>{sv.saving ? 'Saving…' : editing ? 'Save changes' : 'Add meeting'}</button>
        </div>
      </form>
      {sv.dupes && <DuplicateDialog type="meeting" duplicates={sv.dupes} onCancel={() => { sv.setDupes(null); onClose(); }} onForce={() => { sv.setDupes(null); save(true); }} />}
    </Modal>
  );
}
