import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { Badge, Card, ErrorBox, Field, Loading, Page, useAsync } from '../ui.jsx';
import { ReminderEditor } from '../ItemForms.jsx';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];

const PILL = {
  active: ['good', 'Working'], ready: ['info', 'Ready'], needs_device: ['warn', 'Needs a device'],
  not_connected: ['neutral', 'Not connected'], client: ['info', 'This browser'],
};

function Pill({ status }) {
  const [tone, label] = PILL[status] || ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

function Integrations({ settings, saveChannels, savePhone }) {
  const { toast, version } = useApp();
  const { data, loading, error, reload } = useAsync(() => api.get('/integrations'), [version, settings.channels.push, settings.channels.sms, settings.channels.call, settings.phone]);
  const [results, setResults] = useState({});
  const [phone, setPhone] = useState(settings.phone || '');
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />;

  const test = async (ch) => {
    setResults((r) => ({ ...r, [ch]: { status: 'running', detail: 'Sending…' } }));
    try { const r = await api.post(`/integrations/${ch}/test`); setResults((x) => ({ ...x, [ch]: r })); }
    catch (e) { setResults((x) => ({ ...x, [ch]: { status: 'failed', detail: e.message } })); }
  };
  const Result = ({ ch }) => results[ch] ? (
    <p className={`small ${results[ch].status === 'sent' ? 'ok' : 'meta-alert'}`} role="status">
      Test {results[ch].status}: {results[ch].detail}
    </p>
  ) : null;

  async function enableBrowser() {
    if (typeof Notification === 'undefined') { toast({ message: 'This browser does not support notifications.', tone: 'error' }); return; }
    const p = await Notification.requestPermission();
    setPerm(p);
    toast({ message: p === 'granted' ? 'Browser notifications are on (they only work while DayPilot is open in a tab).' : 'Permission was not granted.', tone: p === 'granted' ? 'success' : 'error' });
  }

  async function enablePushDevice() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support web push. On iPhone, add DayPilot to the Home Screen first.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission was not granted.');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.push.public_key) });
      await api.post('/push/subscribe', sub.toJSON());
      toast({ message: 'This device is registered for push. Use “Send test” to confirm it really arrives.', tone: 'success' });
      reload();
    } catch (e) { toast({ message: e.message, tone: 'error', ms: 9000 }); }
  }

  const feed = data.calendar_feed;
  const copyFeed = async () => { try { await navigator.clipboard.writeText(feed.url); toast({ message: 'Calendar link copied.', tone: 'success' }); } catch { toast({ message: 'Copy blocked — select the link and copy it manually.', tone: 'error' }); } };

  return (
    <div className="integrations">
      <Card title="In-app notifications" aside={<Pill status={data.in_app.status} />}>
        <p>{data.in_app.detail}</p>
      </Card>

      <Card title="Browser notifications" aside={<Pill status={data.browser.status} />}>
        <p>{data.browser.detail}</p>
        <p className="small muted">Permission: <strong>{perm}</strong>. These only appear while DayPilot is open in a tab. For alerts when the app is closed, use Web Push or SMS below.</p>
        {perm !== 'granted' && perm !== 'unsupported' && <button className="btn" onClick={enableBrowser}>Turn on browser notifications</button>}
      </Card>

      <Card title="Web push (phone and desktop, app closed)" aside={<Pill status={data.push.status} />}>
        {data.push.missing.length > 0 ? (
          <>
            <p>Not connected. Add these to <code>server/.env</code> and restart: <code>{data.push.missing.join(', ')}</code>.</p>
            <p className="small muted">Generate the keys with <code>npm run vapid -w server</code>. Needs HTTPS (or localhost) — see README, “Push notifications”.</p>
          </>
        ) : (
          <>
            <p>Server keys found. {data.push.subscriptions} device(s) registered.</p>
            <div className="row wrap">
              <button className="btn" onClick={enablePushDevice}>Enable on this device</button>
              <label className="switch"><input type="checkbox" checked={settings.channels.push} onChange={(e) => saveChannels({ push: e.target.checked })} /> Send reminders by push</label>
              <button className="btn btn-ghost" onClick={() => test('push')}>Send test</button>
            </div>
            <Result ch="push" />
          </>
        )}
      </Card>

      <Card title="SMS and phone calls (Twilio)" aside={<Pill status={data.sms.status} />}>
        {data.sms.missing.length > 0 && <p>Not connected yet. Still needed: <code>{data.sms.missing.join(', ')}</code>. See README, “SMS and phone calls”.</p>}
        <div className="row wrap">
          <Field label="Your mobile number (with country code)" className="grow">
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" />
          </Field>
          <button className="btn" onClick={() => savePhone(phone)}>Save number</button>
        </div>
        {data.sms.missing.filter((m) => m.startsWith('TWILIO')).length === 0 && (
          <div className="stack">
            <div className="row wrap">
              <label className="switch"><input type="checkbox" checked={settings.channels.sms} onChange={(e) => saveChannels({ sms: e.target.checked })} /> Text me my reminders</label>
              <button className="btn btn-ghost" onClick={() => test('sms')}>Send test SMS</button>
            </div>
            <Result ch="sms" />
            <div className="row wrap">
              <label className="switch"><input type="checkbox" checked={settings.channels.call} onChange={(e) => saveChannels({ call: e.target.checked })} /> Call me for meetings about to start and at-risk deadlines</label>
              <button className="btn btn-ghost" onClick={() => test('call')}>Place test call</button>
            </div>
            <Result ch="call" />
          </div>
        )}
        <p className="small muted">“Test” results show what the provider actually answered. A message is only counted as sent when Twilio accepts it.</p>
      </Card>

      <Card title="Calendar sync (read-only feed)" aside={<Pill status={feed.status} />}>
        <p>Subscribe to your meetings and task deadlines from Google, Apple or Outlook Calendar using this private link.</p>
        <div className="row wrap">
          <input readOnly value={feed.url} aria-label="Private calendar feed link" className="grow" onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={copyFeed}>Copy link</button>
        </div>
        <p className="small muted">Keep this link private. Calendar apps can only read it if DayPilot is reachable at a public https address — a <code>localhost</code> link will not work from Google Calendar. Calendar apps refresh subscribed feeds on their own schedule (often hours).</p>
      </Card>

      <Card title="Google Calendar two-way sync" aside={<Pill status={data.google_calendar.status} />}>
        <p>{data.google_calendar.detail}</p>
      </Card>
    </div>
  );
}

export default function Settings() {
  const { settings, reloadSettings, toast, bump } = useApp();
  const [d, setD] = useState(() => JSON.parse(JSON.stringify(settings)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const zones = (() => {
    let list = [];
    try { list = Intl.supportedValuesOf('timeZone'); } catch { list = ['Asia/Kolkata', 'UTC']; }
    return list.includes(d.timezone) ? list : [d.timezone, ...list];
  })();
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));

  async function save(patch = d, message = 'Settings saved.') {
    setSaving(true); setError(null);
    try {
      await api.put('/settings', patch);
      await reloadSettings();
      bump();
      toast({ message, tone: 'success' });
    } catch (e) { setError(e); } finally { setSaving(false); }
  }

  const saveChannels = async (patch) => {
    const channels = { ...settings.channels, ...patch };
    try { await api.put('/settings', { channels }); await reloadSettings(); } catch (e) { toast({ message: e.message, tone: 'error' }); }
  };
  const savePhone = (phone) => save({ phone }, phone ? 'Phone number saved.' : 'Phone number removed.');

  const toggleDay = (n) => {
    const has = d.work_days.includes(n);
    set('work_days', has ? d.work_days.filter((x) => x !== n) : [...d.work_days, n].sort());
  };

  async function sample(action) {
    try {
      if (action === 'load') { const r = await api.post('/data/sample/load'); toast({ message: r.skipped ? 'Sample data is already loaded.' : `Added ${r.tasks} sample tasks and ${r.meetings} sample meetings.` }); }
      else { const r = await api.del('/data/sample'); toast({ message: `Removed ${r.tasks} sample tasks and ${r.meetings} sample meetings. Your own items are untouched.` }); }
      bump();
    } catch (e) { toast({ message: e.message, tone: 'error' }); }
  }

  return (
    <Page title="Settings" subtitle="Time zone, working hours, reminders and notification channels">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
        <Card title="Time and working hours">
          <div className="grid3">
            <Field label="Time zone" error={error?.field === 'timezone' ? error.message : null}>
              <select value={d.timezone} onChange={(e) => set('timezone', e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>
            </Field>
            <Field label="Work starts" error={error?.field === 'work_start' ? error.message : null}><input type="time" value={d.work_start} onChange={(e) => set('work_start', e.target.value)} required /></Field>
            <Field label="Work ends"><input type="time" value={d.work_end} onChange={(e) => set('work_end', e.target.value)} required /></Field>
          </div>
          <fieldset className="days">
            <legend>Working days</legend>
            {DAYS.map(([n, label]) => (
              <label key={n} className="switch"><input type="checkbox" checked={d.work_days.includes(Number(n))} onChange={() => toggleDay(Number(n))} /> {label}</label>
            ))}
          </fieldset>
        </Card>

        <Card title="Reminders and briefings">
          <div className="grid3">
            <Field label="End-of-day briefing at" hint="An in-app notification with your summary is created at this time"><input type="time" value={d.eod_time} onChange={(e) => set('eod_time', e.target.value)} required /></Field>
            <Field label="“Day before” reminders at" hint="Your preferred evening reminder time"><input type="time" value={d.day_before_time} onChange={(e) => set('day_before_time', e.target.value)} required /></Field>
            <Field label="Meeting heads-up (minutes before)" hint="0 turns the extra heads-up off"><input type="number" min="0" max="120" value={d.meeting_headsup_minutes} onChange={(e) => set('meeting_headsup_minutes', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
          </div>
          <div className="grid2">
            <Field label="Default meeting length (minutes)"><input type="number" min="5" max="480" value={d.default_meeting_minutes} onChange={(e) => set('default_meeting_minutes', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
            <Field label="Warn about high-priority tasks due within (hours)"><input type="number" min="1" max="48" value={d.risk_hours} onChange={(e) => set('risk_hours', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
          </div>
          <div className="grid2">
            <ReminderEditor legend="Default reminders for new meetings" value={d.default_meeting_reminders} onChange={(v) => set('default_meeting_reminders', v)} hasAnchor anchorWord="start time" allowAbsolute={false} />
            <ReminderEditor legend="Default reminders for new tasks with a due date" value={d.default_task_reminders} onChange={(v) => set('default_task_reminders', v)} hasAnchor anchorWord="due date" allowAbsolute={false} />
          </div>
        </Card>

        {error && !error.field && <div className="alert alert-danger" role="alert">{error.message}</div>}
        <div className="row"><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
      </form>

      <h2 className="section-title">Notification channels and integrations</h2>
      <Integrations settings={settings} saveChannels={saveChannels} savePhone={savePhone} />

      <Card title="Sample data">
        <p>The example meetings and tasks that came with the app. Removing them never touches items you created yourself.</p>
        <div className="row wrap">
          <button className="btn" onClick={() => sample('load')}>Load sample data</button>
          <button className="btn btn-ghost-danger" onClick={() => sample('clear')}>Remove sample data</button>
        </div>
      </Card>
    </Page>
  );
}
