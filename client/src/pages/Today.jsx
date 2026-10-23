import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { Badge, Card, Empty, ErrorBox, Loading, Page, useAsync } from '../ui.jsx';
import { MeetingRow, TaskRow } from '../rows.jsx';
import { fmtTime, fmtYmd, greeting, humanMin } from '../time.js';

function Workload({ w }) {
  if (!w.work_day) return <p className="muted">Today is outside your working days, so no capacity is counted.</p>;
  const total = Math.max(w.capacity_min, w.meeting_min + w.task_min, 1);
  const pct = (v) => `${Math.min(100, (v / total) * 100)}%`;
  return (
    <div>
      <div className="meter" role="img" aria-label={`${humanMin(w.meeting_min)} of meetings, ${humanMin(w.task_min)} of planned tasks, ${humanMin(w.free_min)} free`}>
        <span className="m-meet" style={{ width: pct(w.meeting_min) }} />
        <span className="m-task" style={{ width: pct(w.task_min) }} />
      </div>
      <p className="small muted">
        Left today: {humanMin(w.capacity_min)} of working time · meetings {humanMin(w.meeting_min)} · task estimates {humanMin(w.task_min)} · free {humanMin(w.free_min)}
      </p>
      {w.overbooked && <p className="meta-alert small"><strong>Heads up:</strong> your planned tasks are more than the free time you have left. Move something or shorten it.</p>}
    </div>
  );
}

export default function Today() {
  const { version, settings, openForm, bump, toast } = useApp();
  const tz = settings.timezone;
  const { data, loading, error, reload } = useAsync(() => api.get('/briefing/today'), [version]);
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />;

  const { meetings, tasks, priorities, reminders, alerts, workload, next_up: next } = data;
  const edit = (it) => openForm({ type: it.type, item: it });
  const openCount = tasks.overdue.length + tasks.due.length;
  const nothing = !meetings.length && !openCount && !tasks.completed.length;

  async function dismiss(id) {
    try { await api.post(`/reminders/${id}/dismiss`); bump(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }
  async function snooze(id) {
    try { await api.post(`/reminders/${id}/snooze`, { minutes: 10 }); toast({ message: 'Snoozed for 10 minutes.' }); bump(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }

  return (
    <Page
      title={`${greeting(tz)}`}
      subtitle={`${fmtYmd(data.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${settings.timezone}`}
      actions={<a className="btn" href="#/summary">Wrap up my day</a>}
    >
      <ErrorBox error={error} onRetry={reload} />

      {(alerts.at_risk.length > 0 || alerts.conflicts.length > 0) && (
        <Card tone="warn" title="Needs attention">
          <ul className="plain">
            {alerts.at_risk.map((t) => (
              <li key={t.id}><Badge tone={t.risk.level === 'overdue' ? 'danger' : 'warn'}>{t.risk.level === 'overdue' ? 'Overdue' : 'At risk'}</Badge> <button className="linklike" onClick={() => edit(t)}>{t.title}</button> — {t.risk.reason}</li>
            ))}
            {alerts.conflicts.map((c, i) => (
              <li key={i}><Badge tone="warn">Clash</Badge> “{c.a.title}” overlaps “{c.b.title}” ({fmtTime(c.b.start_at, tz)})</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="stats">
        <div className="stat"><span className="stat-n">{meetings.filter((m) => m.phase !== 'past').length}</span><span>meetings left</span></div>
        <div className="stat"><span className="stat-n">{openCount}</span><span>tasks open today</span></div>
        <div className="stat stat-good"><span className="stat-n">{tasks.completed.length}</span><span>completed today</span></div>
        <div className="stat"><span className="stat-n">{humanMin(workload.free_min)}</span><span>free time left</span></div>
      </div>

      {next && (
        <Card title={next.live ? 'Happening now' : 'Next up'} tone="accent">
          <p className="next-up">
            <strong>{next.title}</strong> · {next.type === 'meeting' ? (next.live ? 'started' : 'starts') : 'due'} {fmtTime(next.at, tz)}
          </p>
        </Card>
      )}

      {nothing && (
        <Empty
          title="Your day is clear"
          hint="Nothing is scheduled yet. Use the quick add bar above — for example “Call Payal tomorrow at 10”."
          action={<div className="row"><button className="btn btn-primary" onClick={() => openForm({ type: 'task' })}>New task</button><button className="btn" onClick={() => openForm({ type: 'meeting' })}>New meeting</button></div>}
        />
      )}

      <div className="cols">
        <div className="col">
          <Card title="Today’s meetings" aside={<button className="btn btn-small" onClick={() => openForm({ type: 'meeting' })}>+ Meeting</button>}>
            {meetings.length ? <ul className="list">{meetings.map((m) => <MeetingRow key={m.id} meeting={m} onEdit={edit} />)}</ul> : <p className="muted">No meetings today.</p>}
          </Card>
          <Card title="Workload">
            <Workload w={workload} />
          </Card>
          <Card title="Reminders today">
            {reminders.length ? (
              <ul className="list">
                {reminders.map((r) => (
                  <li className="item" key={r.id}>
                    <div className="time-col"><strong>{fmtTime(r.remind_at, tz)}</strong></div>
                    <div className="item-main">
                      <span className="item-title">{r.title}</span>
                      <div className="meta"><span>{r.item_type}</span><span>{r.status === 'fired' ? 'Shown in app' : 'Upcoming'}</span></div>
                    </div>
                    <div className="item-side">
                      {r.status === 'pending' && <button className="btn btn-small btn-ghost" onClick={() => dismiss(r.id)} aria-label={`Dismiss reminder for ${r.title}`}>Dismiss</button>}
                      {r.status === 'fired' && <button className="btn btn-small btn-ghost" onClick={() => snooze(r.id)} aria-label={`Snooze reminder for ${r.title} by 10 minutes`}>Snooze 10m</button>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No reminders for the rest of today.</p>}
          </Card>
        </div>

        <div className="col">
          <Card title="Top priorities">
            {priorities.length ? <ul className="list">{priorities.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul> : <p className="muted">Nothing urgent. Nice.</p>}
          </Card>
          <Card title="Due today" aside={<button className="btn btn-small" onClick={() => openForm({ type: 'task' })}>+ Task</button>}>
            {tasks.overdue.length > 0 && (<><h3 className="subhead danger">Overdue</h3><ul className="list">{tasks.overdue.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul></>)}
            {tasks.due.length > 0 ? <ul className="list">{tasks.due.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul> : tasks.overdue.length === 0 && <p className="muted">No tasks due today.</p>}
          </Card>
          <Card title="Completed today">
            {tasks.completed.length ? <ul className="list">{tasks.completed.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul> : <p className="muted">Nothing completed yet. Tick a task above when it is done.</p>}
          </Card>
        </div>
      </div>
    </Page>
  );
}
