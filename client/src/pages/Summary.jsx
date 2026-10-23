import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { Badge, Card, ErrorBox, Field, Loading, Page, useAsync } from '../ui.jsx';
import { MeetingRow, TaskRow } from '../rows.jsx';
import { PrepList } from './Tomorrow.jsx';
import { fmt12, fmtDay, fmtTime, fmtYmd, humanMin, ymdIn } from '../time.js';

export default function Summary() {
  const { version, settings, openForm, bump, toast, openItem } = useApp();
  const tz = settings.timezone;
  const [date, setDate] = useState(ymdIn(tz));
  const { data, loading, error, reload } = useAsync(() => api.get(`/summary/end-of-day?date=${date}`), [date, version]);
  const edit = (it) => openForm({ type: it.type, item: it });

  async function copy() {
    try { await navigator.clipboard.writeText(data.text); toast({ message: 'Summary copied. Paste it into WhatsApp, email or notes.', tone: 'success' }); }
    catch { toast({ message: 'Your browser blocked copying. Select the text in “Plain-text version” instead.', tone: 'error' }); }
  }
  async function review() {
    try { await api.post('/briefing/review', { date: data.tomorrow.date }); toast({ message: 'Tomorrow marked as reviewed.', tone: 'success' }); bump(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }

  return (
    <Page
      title="End-of-day summary"
      subtitle={`Generated on request, and automatically as an in-app notification at ${fmt12(settings.eod_time)}.`}
      actions={<Field label="Day"><input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>}
    >
      <ErrorBox error={error} onRetry={reload} />
      {!data && loading && <Loading />}
      {data && (
        <>
          <Card tone="accent">
            <p className="headline">{data.headline}</p>
            <div className="row wrap">
              <button className="btn btn-primary" onClick={copy}>Copy summary</button>
              <button className="btn" onClick={reload}>Refresh</button>
            </div>
          </Card>

          <div className="cols">
            <div className="col">
              <Card title={`Completed (${data.completed.length})`} aside={data.completed_minutes ? <span className="muted small">≈ {humanMin(data.completed_minutes)} planned work</span> : null}>
                {data.completed.length ? <ul className="list">{data.completed.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul> : <p className="muted">Nothing was marked complete on this day.</p>}
              </Card>
              <Card title={`Still pending (${data.pending.length})`} tone={data.pending.length ? 'warn' : undefined}>
                {data.pending.length ? <ul className="list">{data.pending.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul> : <p className="muted">Nothing due or overdue. You are clear.</p>}
                {data.undated_open > 0 && <p className="muted small">Plus {data.undated_open} open task{data.undated_open === 1 ? '' : 's'} with no due date.</p>}
              </Card>
              <Card title={`Meetings (${data.meetings_held.length})`}>
                {data.meetings_held.length ? <ul className="list">{data.meetings_held.map((m) => <MeetingRow key={m.id} meeting={m} onEdit={edit} />)}</ul> : <p className="muted">No meetings.</p>}
              </Card>
            </div>
            <div className="col">
              <Card title="Coming up after tomorrow (next 3 days)">
                {!data.upcoming_deadlines.length && !data.upcoming_meetings.length && <p className="muted">No deadlines or meetings in the 3 days after tomorrow.</p>}
                {data.upcoming_deadlines.length > 0 && <ul className="list">{data.upcoming_deadlines.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul>}
                {data.upcoming_meetings.length > 0 && <ul className="list">{data.upcoming_meetings.map((m) => <MeetingRow key={m.id} meeting={m} onEdit={edit} showDay />)}</ul>}
              </Card>
              <Card
                title={`Tomorrow — ${fmtYmd(data.tomorrow.date)}`}
                aside={data.tomorrow.reviewed_at ? <Badge tone="good">Reviewed {fmtTime(data.tomorrow.reviewed_at, tz)}</Badge> : <button className="btn btn-small btn-primary" onClick={review}>Mark reviewed</button>}
              >
                {data.tomorrow.meetings.length === 0 && data.tomorrow.tasks.due.length === 0 && <p className="muted">Nothing scheduled yet.</p>}
                {data.tomorrow.meetings.length > 0 && <ul className="list">{data.tomorrow.meetings.map((m) => <MeetingRow key={m.id} meeting={m} onEdit={edit} />)}</ul>}
                {data.tomorrow.tasks.due.length > 0 && <ul className="list">{data.tomorrow.tasks.due.map((t) => <TaskRow key={t.id} task={t} onEdit={edit} />)}</ul>}
                <h3 className="subhead">Preparation needed</h3>
                <PrepList prep={data.tomorrow.prep} onEdit={(p) => openItem(p.type, p.id)} />
              </Card>
              <Card title="Plain-text version">
                <pre className="plain-text" tabIndex={0} aria-label="Summary as plain text">{data.text}</pre>
              </Card>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
