import { useApp } from './ctx.js';
import { Badge } from './ui.jsx';
import { dueLabel, fmtTime, humanMin, relDay } from './time.js';

export function RiskBadge({ risk }) {
  if (!risk) return null;
  return risk.level === 'overdue'
    ? <Badge tone="danger" title={risk.reason}>Overdue</Badge>
    : <Badge tone="warn" title={risk.reason}>At risk</Badge>;
}

export function TaskRow({ task, onEdit }) {
  const { settings, completeTask, reopenTask } = useApp();
  const tz = settings.timezone;
  const done = task.status === 'done';
  return (
    <li className={`item ${done ? 'is-done' : ''}`}>
      <button
        className={`check ${done ? 'checked' : ''}`}
        aria-label={done ? `Reopen task: ${task.title}` : `Mark complete: ${task.title}`}
        aria-pressed={done}
        onClick={() => (done ? reopenTask(task) : completeTask(task))}
      >
        {done ? '✓' : ''}
      </button>
      <div className="item-main">
        <button className="item-title linklike" onClick={() => onEdit(task)}>{task.title}</button>
        <div className="meta">
          {done
            ? <span>Completed {task.completed_at ? fmtTime(task.completed_at, tz) : ''}</span>
            : <span className={task.risk ? 'meta-alert' : ''}>{dueLabel(task, tz)}</span>}
          {task.est_minutes ? <span>~{humanMin(task.est_minutes)}</span> : null}
          {task.project ? <span className="tag">{task.project}</span> : null}
        </div>
        {!done && task.risk && <div className="meta meta-alert">{task.risk.reason}</div>}
      </div>
      <div className="item-side">
        {!done && <RiskBadge risk={task.risk} />}
        {task.priority === 'high' && <Badge tone="high">High</Badge>}
        {task.priority === 'low' && <Badge tone="low">Low</Badge>}
      </div>
    </li>
  );
}

const PHASE = { live: ['info', 'Now'], past: ['neutral', 'Done'], cancelled: ['danger', 'Cancelled'] };

export function MeetingRow({ meeting: m, onEdit, showDay = false }) {
  const { settings } = useApp();
  const tz = settings.timezone;
  const phase = PHASE[m.phase];
  return (
    <li className={`item meeting ${m.phase === 'past' || m.phase === 'cancelled' ? 'is-done' : ''}`}>
      <div className="time-col" aria-label={`${fmtTime(m.start_at, tz)} to ${fmtTime(m.end_at, tz)}`}>
        <strong>{fmtTime(m.start_at, tz)}</strong>
        <span>{fmtTime(m.end_at, tz)}</span>
      </div>
      <div className="item-main">
        <button className="item-title linklike" onClick={() => onEdit(m)}>{m.title}</button>
        <div className="meta">
          {showDay && <span>{relDay(m.start_local.slice(0, 10), tz)}</span>}
          <span>{humanMin(m.duration_min)}</span>
          {m.attendees.length ? <span>{m.attendees.slice(0, 3).join(', ')}{m.attendees.length > 3 ? ` +${m.attendees.length - 3}` : ''}</span> : null}
          {m.location ? <span>{m.location}</span> : null}
          {m.link ? <a href={m.link} target="_blank" rel="noopener noreferrer">Join link</a> : null}
          {m.project ? <span className="tag">{m.project}</span> : null}
        </div>
        {m.prep && m.phase !== 'past' && <div className="meta prep">Prep: {m.prep}</div>}
      </div>
      <div className="item-side">{phase && <Badge tone={phase[0]}>{phase[1]}</Badge>}</div>
    </li>
  );
}
