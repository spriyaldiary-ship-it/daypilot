import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { AppCtx } from './ctx.js';
import { Loading, ErrorBox } from './ui.jsx';
import { MeetingForm, TaskForm } from './ItemForms.jsx';
import QuickCapture from './QuickCapture.jsx';
import Today from './pages/Today.jsx';
import Tomorrow from './pages/Tomorrow.jsx';
import ListPage from './pages/ListPage.jsx';
import Summary from './pages/Summary.jsx';
import Settings from './pages/Settings.jsx';
import { fmtDay, fmtTime } from './time.js';

const NAV = [
  ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['tasks', 'Tasks'], ['meetings', 'Meetings'],
  ['search', 'Search'], ['summary', 'End of day'], ['settings', 'Settings'],
];

const CHANNEL = { 'in-app': 'In-app', push: 'Push', sms: 'SMS', call: 'Call' };

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'today';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const f = () => { setRoute(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return NAV.some(([k]) => k === route) ? route : 'today';
}

function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone || 'info'}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          {t.action && <button className="btn btn-small" onClick={() => { t.action.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
          <button className="btn btn-ghost btn-icon" aria-label="Dismiss message" onClick={() => dismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

function Bell({ data, tz, onRead, onReadAll, onOpen, onSnooze }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button className="btn btn-icon bell-btn" aria-label={`Notifications, ${data.unread} unread`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></svg>
        {data.unread > 0 && <span className="bell-count">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel card" role="dialog" aria-label="Notifications">
          <div className="card-head">
            <h2>Notifications</h2>
            {data.unread > 0 && <button className="btn btn-small btn-ghost" onClick={onReadAll}>Mark all read</button>}
          </div>
          {data.notifications.length === 0 && <p className="muted">Nothing yet. Reminders, meeting alerts, deadline warnings and your end-of-day summary will show up here.</p>}
          <ul className="notif-list">
            {data.notifications.slice(0, 15).map((n) => {
              const reminderId = n.kind === 'reminder' && /^reminder:(\d+):/.exec(n.dedupe_key || '');
              return (
                <li key={n.id} className={n.read_at ? '' : 'unread'}>
                  <div className="notif-title">{n.title}</div>
                  {n.body && <div className="notif-body">{n.body}</div>}
                  <div className="meta">
                    <span>{fmtDay(n.created_at, tz)}, {fmtTime(n.created_at, tz)}</span>
                    <span title={n.deliveries.map((d) => `${CHANNEL[d.channel] || d.channel}: ${d.detail}`).join('\n')}>
                      {n.deliveries.length ? n.deliveries.map((d) => `${CHANNEL[d.channel] || d.channel}: ${d.status}`).join(' · ') : 'In-app'}
                    </span>
                  </div>
                  <div className="row wrap">
                    {n.ref_type && <button className="btn btn-small" onClick={() => { onOpen(n.ref_type, n.ref_id); setOpen(false); }}>Open</button>}
                    {reminderId && <button className="btn btn-small btn-ghost" onClick={() => onSnooze(Number(reminderId[1]))}>Snooze 10 min</button>}
                    {n.kind === 'eod' && <a className="btn btn-small" href="#/summary" onClick={() => setOpen(false)}>View summary</a>}
                    {!n.read_at && <button className="btn btn-small btn-ghost" onClick={() => onRead(n.id)}>Mark read</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function App({ onLogout = null }) {
  const route = useRoute();
  const [settings, setSettings] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [form, setForm] = useState(null);
  const [projects, setProjects] = useState([]);
  const [notes, setNotes] = useState({ notifications: [], unread: 0 });
  const lastId = useRef(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-3), { id, ...t }]);
    setTimeout(() => dismiss(id), t.ms || 5500);
  }, [dismiss]);

  const loadSettings = useCallback(async () => {
    try { const r = await api.get('/settings'); setSettings(r.settings); setBootError(null); } catch (e) { setBootError(e); }
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  useEffect(() => {
    if (!settings) return;
    api.get('/projects').then((r) => setProjects(r.projects)).catch(() => {});
  }, [settings, version]);

  const poll = useCallback(async () => {
    try {
      const d = await api.get('/notifications');
      setNotes(d);
      const max = d.notifications.reduce((m, n) => Math.max(m, n.id), 0);
      if (lastId.current === null) { lastId.current = max; return; }
      const fresh = d.notifications.filter((n) => n.id > lastId.current).reverse();
      lastId.current = Math.max(lastId.current, max);
      for (const n of fresh) {
        toast({ message: `${n.title}${n.body ? ` — ${n.body}` : ''}`, tone: n.kind === 'deadline_risk' ? 'warn' : 'info', ms: 9000 });
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          try { new Notification(n.title, { body: n.body }); } catch { /* ignore */ }
        }
      }
      if (fresh.length) bump();
    } catch { /* offline: try again on the next tick */ }
  }, [toast, bump]);

  useEffect(() => {
    if (!settings) return undefined;
    poll();
    const id = setInterval(poll, 30000);
    const vis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, [settings, poll]);

  const reopenTask = useCallback(async (task) => {
    try { await api.post(`/tasks/${task.id}/reopen`); toast({ message: `Reopened: “${task.title}”.` }); bump(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }, [toast, bump]);

  const completeTask = useCallback(async (task) => {
    try {
      const r = await api.post(`/tasks/${task.id}/complete`);
      toast({ message: r.completion.message, tone: 'success', ms: 9000, action: { label: 'Undo', onClick: () => reopenTask(task) } });
      bump();
    } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }, [toast, bump, reopenTask]);

  const openForm = useCallback((f) => setForm({ ...f, key: Math.random() }), []);
  const openItem = useCallback(async (type, id) => {
    try {
      const r = await api.get(`/${type === 'task' ? 'tasks' : 'meetings'}/${id}`);
      openForm({ type, item: r[type] });
    } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }, [openForm, toast]);

  const snooze = async (id) => {
    try { await api.post(`/reminders/${id}/snooze`, { minutes: 10 }); toast({ message: 'Snoozed for 10 minutes.' }); bump(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  };
  const read = async (id) => { try { await api.post(`/notifications/${id}/read`); poll(); } catch { /* ignore */ } };
  const readAll = async () => { try { await api.post('/notifications/read-all'); poll(); } catch { /* ignore */ } };

  if (!settings) {
    return (
      <div className="boot">
        <h1>DayPilot</h1>
        {bootError ? <ErrorBox error={bootError} onRetry={loadSettings} /> : <Loading />}
      </div>
    );
  }

  const ctx = {
    settings, reloadSettings: loadSettings, version, bump, toast, openForm, openItem, completeTask, reopenTask, projects,
  };
  const page = {
    today: <Today />, tomorrow: <Tomorrow />, tasks: <ListPage mode="tasks" />, meetings: <ListPage mode="meetings" />,
    search: <ListPage mode="search" />, summary: <Summary />, settings: <Settings />,
  }[route];

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <button className="skip-link" onClick={() => document.getElementById('main')?.focus()}>Skip to content</button>
        <nav className="sidebar" aria-label="Main">
          <div className="brand"><span className="brand-mark" aria-hidden="true">✓</span> DayPilot</div>
          <ul>
            {NAV.map(([k, label]) => (
              <li key={k}><a href={`#/${k}`} className={route === k ? 'active' : ''} aria-current={route === k ? 'page' : undefined}>{label}</a></li>
            ))}
          </ul>
        </nav>
        <div className="main-col">
          <header className="topbar">
            <QuickCapture />
            <Bell data={notes} tz={settings.timezone} onRead={read} onReadAll={readAll} onOpen={openItem} onSnooze={snooze} />
            {onLogout && <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>}
          </header>
          <main id="main" tabIndex={-1}>{page}</main>
        </div>
        <datalist id="project-list">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <Toasts toasts={toasts} dismiss={dismiss} />
        {form && form.type === 'task' && <TaskForm key={form.key} initial={form.item} draft={form.draft} onClose={() => setForm(null)} />}
        {form && form.type === 'meeting' && <MeetingForm key={form.key} initial={form.item} draft={form.draft} onClose={() => setForm(null)} />}
      </div>
    </AppCtx.Provider>
  );
}
