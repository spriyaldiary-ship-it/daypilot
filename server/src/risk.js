import { workingMinutes } from './tz.js';
import { humanMinutes } from './format.js';

// Returns { level: 'overdue' | 'at_risk', reason } or null.
export function assessTaskRisk(task, now, s) {
  if (task.status !== 'open' || !task.due_at) return null;
  const due = new Date(task.due_at);
  if (due < now) {
    return { level: 'overdue', reason: `Overdue by ${humanMinutes((now - due) / 60000)}` };
  }
  const need = task.est_minutes || 0;
  const left = workingMinutes(now, due, s.timezone, s.work_start, s.work_end, s.work_days);
  if (need && left < need) {
    return { level: 'at_risk', reason: `Needs about ${humanMinutes(need)} but only ${humanMinutes(left)} of working time is left before it is due` };
  }
  const hoursToDue = (due - now) / 3600000;
  if (task.priority === 'high' && hoursToDue <= s.risk_hours) {
    return { level: 'at_risk', reason: `High priority and due in ${humanMinutes((due - now) / 60000)}` };
  }
  return null;
}
