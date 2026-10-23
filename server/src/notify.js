// Delivery channels. Rule: a delivery is only recorded as "sent" when the provider actually accepted it.
// If a channel is not configured, the delivery is recorded as "skipped" with the reason, never as sent.

export const TWILIO_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
export const VAPID_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

const missing = (env, names) => names.filter((n) => !env[n]);
const xmlEscape = (t) => String(t).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function createNotifier({ db, getSettings, env = process.env, fetchImpl = globalThis.fetch }) {
  const record = (nid, channel, status, detail) => {
    if (nid) {
      db.prepare('INSERT INTO deliveries (notification_id, channel, status, detail, created_at) VALUES (?,?,?,?,?)')
        .run(nid, channel, status, detail, new Date().toISOString());
    }
    return { channel, status, detail };
  };

  async function twilio(path, form) {
    const sid = env.TWILIO_ACCOUNT_SID;
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `Twilio returned HTTP ${res.status}`);
    return json;
  }

  async function sendPush(n) {
    const lack = missing(env, VAPID_VARS);
    if (lack.length) return { status: 'skipped', detail: `Not configured (missing ${lack.join(', ')})` };
    const subs = db.prepare('SELECT * FROM push_subscriptions').all();
    if (!subs.length) return { status: 'skipped', detail: 'No device has enabled push yet' };
    const wp = (await import('web-push')).default;
    wp.setVapidDetails(env.VAPID_SUBJECT || 'mailto:you@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    let ok = 0;
    const errors = [];
    for (const sub of subs) {
      try {
        await wp.sendNotification(JSON.parse(sub.data), JSON.stringify({ title: n.title, body: n.body, url: '/', tag: `n${n.id || 'test'}` }));
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
        errors.push(e.statusCode ? `HTTP ${e.statusCode}` : e.message);
      }
    }
    if (ok) return { status: 'sent', detail: `Accepted by the push service for ${ok} device(s)${errors.length ? `; ${errors.length} failed` : ''}` };
    return { status: 'failed', detail: errors[0] || 'Push failed' };
  }

  async function sendSms(n, s) {
    const lack = missing(env, TWILIO_VARS);
    if (lack.length) return { status: 'skipped', detail: `Not configured (missing ${lack.join(', ')})` };
    if (!s.phone) return { status: 'skipped', detail: 'No phone number saved in Settings' };
    const r = await twilio('Messages.json', { To: s.phone, From: env.TWILIO_FROM_NUMBER, Body: `${n.title}\n${n.body}`.slice(0, 320) });
    return { status: 'sent', detail: `Accepted by Twilio (${r.status || 'queued'}) — carrier delivery is not confirmed here` };
  }

  async function sendCall(n, s) {
    const lack = missing(env, TWILIO_VARS);
    if (lack.length) return { status: 'skipped', detail: `Not configured (missing ${lack.join(', ')})` };
    if (!s.phone) return { status: 'skipped', detail: 'No phone number saved in Settings' };
    const twiml = `<Response><Say voice="alice">${xmlEscape(`${n.title}. ${n.body}`)}</Say></Response>`;
    const r = await twilio('Calls.json', { To: s.phone, From: env.TWILIO_FROM_NUMBER, Twiml: twiml });
    return { status: 'sent', detail: `Call request accepted by Twilio (${r.status || 'queued'}) — whether you answered is not confirmed here` };
  }

  async function attempt(fn) {
    try { return await fn(); } catch (e) { return { status: 'failed', detail: String(e.message || e).slice(0, 200) }; }
  }

  return {
    async deliver(n) {
      const s = getSettings();
      const out = [record(n.id, 'in-app', 'sent', 'Shown in the app')];
      if (s.channels.push) { const r = await attempt(() => sendPush(n)); out.push(record(n.id, 'push', r.status, r.detail)); }
      if (s.channels.sms) { const r = await attempt(() => sendSms(n, s)); out.push(record(n.id, 'sms', r.status, r.detail)); }
      if (s.channels.call && ['meeting_soon', 'deadline_risk'].includes(n.kind)) {
        const r = await attempt(() => sendCall(n, s));
        out.push(record(n.id, 'call', r.status, r.detail));
      }
      return out;
    },

    // Used by the "Send test" buttons in Settings. Returns the true outcome.
    async test(channel) {
      const s = getSettings();
      const n = { id: null, kind: 'test', title: 'DayPilot test', body: 'If you can read this, this channel works.' };
      if (channel === 'push') return attempt(() => sendPush(n));
      if (channel === 'sms') return attempt(() => sendSms(n, s));
      if (channel === 'call') return attempt(() => sendCall(n, s));
      return { status: 'failed', detail: 'Unknown channel' };
    },

    status(baseUrl, calendarToken) {
      const s = getSettings();
      const vapidLack = missing(env, VAPID_VARS);
      const twLack = missing(env, TWILIO_VARS);
      const subs = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
      const pushStatus = vapidLack.length ? 'not_connected' : subs === 0 ? 'needs_device' : s.channels.push ? 'active' : 'ready';
      const twStatus = (enabled) => (twLack.length || !s.phone ? 'not_connected' : enabled ? 'active' : 'ready');
      const twMissing = [...twLack, ...(s.phone ? [] : ['phone number (Settings)'])];
      return {
        in_app: { status: 'active', detail: 'Always on. Reminders, meeting alerts, deadline warnings and the end-of-day summary appear in the app.' },
        browser: { status: 'client', detail: 'Pop-ups while the app is open in a browser tab. Turn on from this page.' },
        push: { status: pushStatus, enabled: s.channels.push, subscriptions: subs, missing: vapidLack, public_key: env.VAPID_PUBLIC_KEY || null },
        sms: { status: twStatus(s.channels.sms), enabled: s.channels.sms, missing: twMissing },
        call: { status: twStatus(s.channels.call), enabled: s.channels.call, missing: twMissing },
        calendar_feed: { status: 'active', url: `${baseUrl}/api/calendar.ics?token=${calendarToken}` },
        google_calendar: { status: 'not_connected', detail: 'Two-way Google Calendar sync needs Google OAuth credentials. See README: "Google Calendar two-way sync".' },
      };
    },
  };
}
