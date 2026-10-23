import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { Badge, Card, Empty, ErrorBox, Loading, Page, useAsync } from '../ui.jsx';
import { MeetingRow, TaskRow } from '../rows.jsx';
import { fmtTime, fmtYmd, humanMin } from '../time.js';

export const PREP_LABEL = { prep: 'Prepare', no_agenda: 'No agenda', block_time: 'Plan time', due_early: 'Due early' };

export function PrepList({ prep, onEdit }) {
  if (!prep.length) return <p className="muted">Nothing special to prepare. You are good to go.</p>;
  return (
    <ul className="plain">
      {prep.map((p, i) => (
        <li key={`${p.type}-${p.id}-${i}`}>
          <Badge tone={p.kind === 'prep' ? 'info' : 'warn'}>{PREP_LABEL[p.kind]}</Badge>{' '}
          <button className="linklike" onClick={() => onEdit(p)}>{p.title}</button> — {p.text}
        </li>
      ))}
    </ul>
  );
}

export default function Tomorrow() {
  const { version, settings, openForm, bump, toast, openItem } = useApp();
  const tz = settings.timezone;
  const { data, loading, error, reload } = useAsync(() => api.get('/briefing/tomorrow'), [version]);
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />;

  const edit = (it) => openForm({ type: it.type, item: it });
  const w = data.workload;

  async function review() {
    try { await api.post('/briefing/review', { date: data.date }); toast({ message: 'Marked as reviewed. You are ready for tomorrow.', tone: 'success' }); bump(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }

  const empty = !data.meetings.length && !data.tasks.due.length;
  return (
    <Page
      title="Tomorrow"
      subtitle={fmtYmd(data.date, { weekday: 'long', day: 'numeric', month: 'long' })}
      actions={data.reviewed_at
        ? <Badge tone="good">Reviewed at {fmtTime(data.reviewed_at, tz)}</Badge>
        : <button className="btn btn-primary" onClick={review}>Mark as reviewed</button>}
    >
      <ErrorBox error={error} onRetry={reload} />
      {empty ? (
        <Empty title="Nothing scheduled for tomorrow yet" hint="Add meetings or tasks, then come back here to review the day before it starts."
          action={<div className="row"><button className="btn btn-primary" onClick={() => openForm({ type: 'meeting' })}>New meeting</button><button className="btn" onClick={() => openForm({ type: 'task' })}>New task</button></div>} />
      ) : (
        <>
          <div className="stats">
            <div className="stat"><span className="stat-n">{data.meetings.length}</span><span>meetings</span></div>
            <div className="stat"><span className="stat-n">{data.tasks.due.length}</span><span>tasks due</span></div>
            <div className="stat"><span className="stat-n">{data.first_meeting ? fmtTime(data.first_meeting.start_at, tz) : '—'}</span><span>first meeting</span></div>
            <div className="stat"><span className="stat-n">{humanMin(w.free_min)}</span><span>free time</span></div>
          </div>
          {data.alerts.conflicts.length > 0 && (
            <Card tone="warn" title="Schedule clashes">
              <ul className="plain">{data.alerts.conflicts.map((c, i) => <li key={i}>“{c.a.title}” overlaps “{c.b.title}”</li>)}</ul>
            </Card>
          )}
          {w.overbooked && <Card tone="warn" title="Heavy day"><p>Planned tasks ({humanMin(w.task_min)}) are more than your free time ({humanMin(w.free_min)}). Consider moving something.</p></Card>}
          <div className="cols">
            <div className="col">
              <Card title="Preparation needed"><PrepList prep={data.prep} onEdit={(p) => openItem(p.type, p.id)} /></Card>
              <Card title="Tasks due tomorrow">
                {data.tasks.due.length ? <ul className="list">{data.tasks.due.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul> : <p className="muted">No tasks due tomorrow.</p>}
              </Card>
            </div>
            <div className="col">
              <Card title="Schedule">
                {data.meetings.length ? <ul className="list">{data.meetings.map((m) => <MeetingRow key={m.id} meeting={m} onEdit={edit} />)}</ul> : <p className="muted">No meetings tomorrow.</p>}
              </Card>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
