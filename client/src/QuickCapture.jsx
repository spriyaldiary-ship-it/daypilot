import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useApp } from './ctx.js';
import { DuplicateDialog } from './ItemForms.jsx';
import { fmt12, fmtYmd, reminderLabel, relDay } from './time.js';

function whenText(kind, d, tz) {
  if (kind === 'task') {
    if (!d.due) return 'No due date';
    const [day, t] = d.due.split('T');
    return `Due ${relDay(day, tz)}${t ? ` at ${fmt12(t)}` : ''}`;
  }
  if (!d.start) return 'No start time yet';
  const [day, t] = d.start.split('T');
  return `${relDay(day, tz)}, ${fmt12(t)} – ${d.end ? fmt12(d.end.split('T')[1]) : ''}`;
}

export default function QuickCapture() {
  const { settings, bump, toast, openForm } = useApp();
  const tz = settings.timezone;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [parsed, setParsed] = useState(null);
  const [kind, setKind] = useState('task');
  const [dupes, setDupes] = useState(null);
  const input = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const reset = () => { setText(''); setParsed(null); setErr(''); setDupes(null); };

  async function parse() {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const p = await api.post('/capture/parse', { text });
      setParsed(p); setKind(p.kind);
    } catch (e) { setErr(e.message); setParsed(null); } finally { setBusy(false); }
  }

  async function add(force = false) {
    if (!parsed) return;
    const draft = parsed.drafts[kind];
    if (kind === 'meeting' && !draft.start) { setErr('A meeting needs a date and start time. Use “Edit details” to set it.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.post(kind === 'task' ? '/tasks' : '/meetings', { ...draft, force });
      toast({ message: `${kind === 'task' ? 'Task' : 'Meeting'} added: “${draft.title}”.${r.warnings?.length ? ` Heads up: ${r.warnings.join('; ')}.` : ''}`, tone: r.warnings?.length ? 'warn' : 'success', ms: 7000 });
      reset(); bump();
    } catch (e) {
      if (e.code === 'duplicate') setDupes(e.duplicates); else setErr(e.message);
    } finally { setBusy(false); }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (parsed && parsed.original === text.trim().replace(/\s+/g, ' ')) add(); else parse(); }
    if (e.key === 'Escape') { reset(); e.currentTarget.blur(); }
  };

  const d = parsed ? parsed.drafts[kind] : null;
  return (
    <div className="capture">
      <label className="sr-only" htmlFor="quick-capture">Quick add a task or meeting</label>
      <input
        id="quick-capture" ref={input} value={text} disabled={busy}
        onChange={(e) => { setText(e.target.value); if (parsed) setParsed(null); }}
        onKeyDown={onKeyDown}
        placeholder="Quick add: “Call Payal tomorrow at 10 and remind me 15 minutes before”   ( / )"
        autoComplete="off" maxLength={500}
      />
      <button className="btn btn-primary" onClick={parse} disabled={busy || !text.trim()}>{busy ? '…' : 'Add'}</button>
      {err && <div className="capture-pop alert alert-danger" role="alert">{err}</div>}
      {parsed && d && (
        <div className="capture-pop card" role="region" aria-label="Quick add preview" aria-live="polite">
          <div className="seg" role="radiogroup" aria-label="Item type">
            {['task', 'meeting'].map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'task' ? 'Task' : 'Meeting'}
              </button>
            ))}
          </div>
          <div className="preview-title">{d.title}</div>
          <dl className="preview-grid">
            <dt>When</dt><dd className={kind === 'meeting' && !d.start ? 'meta-alert' : ''}>{whenText(kind, d, tz)}</dd>
            {kind === 'meeting' && d.attendees.length > 0 && (<><dt>With</dt><dd>{d.attendees.join(', ')}</dd></>)}
            {kind === 'meeting' && d.location && (<><dt>Where</dt><dd>{d.location}</dd></>)}
            {kind === 'task' && <><dt>Priority</dt><dd>{d.priority}{d.est_minutes ? ` · ~${d.est_minutes} min` : ''}</dd></>}
            {d.project && (<><dt>Project</dt><dd>{d.project}</dd></>)}
            <dt>Reminders</dt>
            <dd>{d.reminders.length ? d.reminders.map((r) => reminderLabel(r, settings)).join(' · ') : 'None'}{parsed.reminders_from_text ? '' : d.reminders.length ? ' (your defaults)' : ''}</dd>
          </dl>
          {parsed.notes.length > 0 && <ul className="notes">{parsed.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <div className="row wrap">
            <button className="btn btn-primary" onClick={() => add()} disabled={busy}>Add {kind} (Enter)</button>
            <button className="btn" onClick={() => { openForm({ type: kind, draft: d }); reset(); }}>Edit details</button>
            <button className="btn btn-ghost" onClick={reset}>Cancel (Esc)</button>
          </div>
        </div>
      )}
      {dupes && <DuplicateDialog type={kind} duplicates={dupes} onCancel={reset} onForce={() => { setDupes(null); add(true); }} />}
    </div>
  );
}
