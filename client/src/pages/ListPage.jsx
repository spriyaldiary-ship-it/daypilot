import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { Card, Empty, ErrorBox, Field, Loading, Page, useAsync } from '../ui.jsx';
import { MeetingRow, TaskRow } from '../rows.jsx';
import { relDay, ymdIn } from '../time.js';

const COPY = {
  tasks: { title: 'Tasks', subtitle: 'Everything you need to do', statuses: [['open', 'Open'], ['done', 'Completed'], ['all', 'All']], dateLabel: 'Due from', dateLabel2: 'Due to' },
  meetings: { title: 'Meetings', subtitle: 'Your calendar of meetings', statuses: [['open', 'Upcoming'], ['done', 'Past'], ['cancelled', 'Cancelled'], ['all', 'All']], dateLabel: 'From', dateLabel2: 'To' },
  search: { title: 'Search', subtitle: 'Find anything by keyword, date, project, priority or status', statuses: [['all', 'Any status'], ['open', 'Open / upcoming'], ['done', 'Completed / past']], dateLabel: 'Date from', dateLabel2: 'Date to' },
};

const blank = (mode) => ({ q: '', status: mode === 'search' ? 'all' : 'open', priority: '', project: '', from: '', to: '', type: 'all' });

export default function ListPage({ mode }) {
  const { version, settings, openForm, projects } = useApp();
  const tz = settings.timezone;
  const copy = COPY[mode];
  const [f, setF] = useState(blank(mode));
  const [q, setQ] = useState('');
  useEffect(() => { setF(blank(mode)); setQ(''); }, [mode]);
  useEffect(() => { const t = setTimeout(() => setQ(f.q), 250); return () => clearTimeout(t); }, [f.q]);

  const type = mode === 'tasks' ? 'task' : mode === 'meetings' ? 'meeting' : f.type;
  const params = new URLSearchParams();
  params.set('type', type);
  params.set('status', f.status);
  if (q.trim()) params.set('q', q.trim());
  if (f.priority && type !== 'meeting') params.set('priority', f.priority);
  if (f.project) params.set('project', f.project);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  const qs = params.toString();

  const { data, loading, error, reload } = useAsync(() => api.get(`/search?${qs}`), [qs, version]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const filtered = f.q || f.priority || f.project || f.from || f.to || f.type !== 'all' || f.status !== blank(mode).status;
  const edit = (it) => openForm({ type: it.type, item: it });

  const groups = [];
  for (const it of data?.items || []) {
    let key, label;
    if (it.type === 'task' && it.status === 'done' && it.completed_at) { key = `c${ymdIn(tz, new Date(it.completed_at))}`; label = `Completed ${relDay(key.slice(1), tz)}`; }
    else if (it.type === 'task') { key = it.due_local ? it.due_local.slice(0, 10) : 'none'; label = it.due_local ? relDay(key, tz) : 'No due date'; }
    else { key = it.start_local.slice(0, 10); label = relDay(key, tz); }
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label, items: [] }; groups.push(g); }
    g.items.push(it);
  }

  const actions = (
    <>
      {mode !== 'meetings' && <button className="btn btn-primary" onClick={() => openForm({ type: 'task' })}>+ New task</button>}
      {mode !== 'tasks' && <button className={`btn ${mode === 'meetings' ? 'btn-primary' : ''}`} onClick={() => openForm({ type: 'meeting' })}>+ New meeting</button>}
    </>
  );

  return (
    <Page title={copy.title} subtitle={copy.subtitle} actions={actions}>
      <form className="filters card" role="search" onSubmit={(e) => e.preventDefault()} aria-label={`${copy.title} filters`}>
        <Field label="Keyword" className="grow"><input type="search" value={f.q} onChange={set('q')} placeholder="Search titles, notes, people, projects…" /></Field>
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>{copy.statuses.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>
        {mode === 'search' && (
          <Field label="Type"><select value={f.type} onChange={set('type')}><option value="all">Tasks and meetings</option><option value="task">Tasks only</option><option value="meeting">Meetings only</option></select></Field>
        )}
        {type !== 'meeting' && (
          <Field label="Priority"><select value={f.priority} onChange={set('priority')}><option value="">Any</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></Field>
        )}
        <Field label="Project"><select value={f.project} onChange={set('project')}><option value="">Any</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
        <Field label={copy.dateLabel}><input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label={copy.dateLabel2}><input type="date" value={f.to} onChange={set('to')} /></Field>
        {filtered && <button type="button" className="btn btn-ghost" onClick={() => { setF(blank(mode)); setQ(''); }}>Clear filters</button>}
      </form>

      <ErrorBox error={error} onRetry={reload} />
      {!data && loading && <Loading />}
      {data && groups.length === 0 && (
        <Empty
          title={filtered ? 'Nothing matches these filters' : mode === 'meetings' ? 'No meetings yet' : 'No tasks yet'}
          hint={filtered ? 'Try a different keyword or clear the filters.' : 'Use the quick add bar at the top or the buttons above.'}
          action={filtered ? <button className="btn" onClick={() => { setF(blank(mode)); setQ(''); }}>Clear filters</button> : null}
        />
      )}
      {data && groups.map((g) => (
        <Card key={g.key} title={g.label} aside={<span className="muted small">{g.items.length}</span>}>
          <ul className="list">
            {g.items.map((it) => (it.type === 'task'
              ? <TaskRow key={`t${it.id}`} task={it} onEdit={edit} />
              : <MeetingRow key={`m${it.id}`} meeting={it} onEdit={edit} />))}
          </ul>
        </Card>
      ))}
      {data && data.items.length >= 200 && <p className="muted small">Showing the first 200 results. Narrow the filters to see others.</p>}
    </Page>
  );
}
