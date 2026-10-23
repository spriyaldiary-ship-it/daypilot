# DayPilot

A personal assistant app for your meetings, tasks, reminders and daily schedule.
Full stack: **Node.js + Express + SQLite** (API, reminder engine) and **React + Vite** (UI).

## Run it

You need **Node.js 22.13 or newer** (`node -v`, download from nodejs.org). SQLite comes built into Node, so there is nothing else to install.

**Easiest: double-click** `start.bat` (Windows) or run `./start.sh` (Mac/Linux). First run installs and builds by itself, then opens http://localhost:3000.

For development:

```bash
cd daypilot
npm install          # installs server + client
npm run dev          # API on :3000, UI on http://localhost:5173
```

One-port production mode (builds the UI and serves everything from the API):

```bash
npm start            # open http://localhost:3000
```

Other commands: `npm test` (27 tests), `npm run seed -- --reset` (refresh sample data).

The first start loads realistic sample meetings and tasks so the dashboard is not empty.
Remove them any time from **Settings → Sample data** (your own items are never touched).

## Where your data is stored

- One SQLite file: `server/data/daypilot.db` (created automatically). Back it up by copying the file.
- Change the location with `DB_FILE=/path/to/file.db`.
- Nothing leaves your computer unless you turn on an integration below.

## What it does

| Area | Details |
| --- | --- |
| Meetings | Title, date, start/end, location or video link, attendees, notes, "what to prepare", project. Overlap warnings. Cancel/restore. |
| Tasks | Title, description, due date/time, priority, estimated minutes, project. Complete / reopen with one tap and **Undo**. |
| Reminders | Several per item: "at the time", minutes/hours/days before, "evening before at your preferred time", or a specific date and time. Snooze and dismiss. Rescheduling an item moves its reminders. |
| Daily briefing | Today: next up, meetings, tasks, overdue, priorities, reminders, workload vs. free time, alerts. |
| Completion update | Completing a task shows what is left today and the next meeting. Completed work feeds the daily activity list and the summary. |
| End-of-day summary | On request, and automatically as an in-app notification at your chosen time: completed, pending, meetings, upcoming deadlines, tomorrow's schedule, copyable plain text. |
| Tomorrow | Schedule, tasks due, **preparation needed** (prep notes, missing agendas, big high-priority tasks, early deadlines), clashes, "Mark as reviewed". |
| Quick capture | Press `/` and type, e.g. `Call Payal tomorrow at 10 and remind me 15 minutes before`. You get a preview (task or meeting, time, reminders, assumptions) and press Enter to add. |
| Duplicates | Similar titles on the same/adjacent day trigger a confirmation before anything is added. |
| Search & filters | Keyword, status, priority, project, date range, type. |
| Settings | Time zone, working hours and days, end-of-day time, "day before" reminder time, meeting heads-up, default reminders, channels. |

Quick capture understands: `today`, `tomorrow`, weekdays (`Friday`, `next Monday`), `25 oct`, `12/11` (day/month), `in 2 hours`, `at 10`, `2-3pm`, `by 5pm`, `for 45 minutes`, `high priority` / `urgent`, `#project`, `remind me 15 minutes before`, `remind me a day before and 10 minutes before`, `remind me to …`. It is rule-based and runs locally; when it assumes something (e.g. "at 4" meaning 4 PM) the preview says so.

## Notifications: what works now and what needs setup

DayPilot never claims something was sent unless the provider accepted it. Every notification stores a delivery record per channel
(`sent`, `failed` or `skipped` with the reason), shown in the bell panel.

| Channel | Status out of the box | What you need |
| --- | --- | --- |
| In-app (bell, toasts, dashboard) | **Works** | Nothing. The server checks every 30 seconds, and the app polls every 30 seconds while open. |
| Browser pop-ups | **Works while the tab is open** | Settings → "Turn on browser notifications". |
| Web push (phone/desktop, app closed) | Needs setup | VAPID keys + HTTPS (below). |
| SMS | Needs setup | Twilio account (below). |
| Phone call | Needs setup | Twilio account (below). |
| Calendar feed (read-only) | **Works** | A public https address for Google Calendar to reach (below). |
| Google Calendar two-way sync | Not built | Google OAuth app (below). |

Important: reminders are only evaluated while the DayPilot **server is running**. If the server is off, reminders that came due fire (marked "the app was not running") the next time it starts. For reliable alerts, keep it running on an always-on machine or host it (see "Deploying").

### Web push

1. `npm run vapid -w server` prints a key pair.
2. Copy `server/.env.example` to `server/.env` and fill `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:you@example.com`). Restart.
3. Open DayPilot over **https** (or `localhost`) → Settings → Web push → **Enable on this device** → switch on **Send reminders by push** → **Send test**.
4. iPhone: add DayPilot to the Home Screen first (Share → Add to Home Screen); web push on iOS only works for installed web apps.

Push services only work with a secure origin, so for your phone you need the app hosted at an https address (see Deploying) or an https tunnel.
The code path is implemented and unit-tested for failure handling, but it has not been exercised against a real phone in this build; use the **Send test** button to confirm on your device.

### SMS and phone calls (Twilio)

1. Create a Twilio account, get an SMS/voice-capable number. (For India, SMS to Indian numbers requires DLT registration, and Twilio trial accounts can only message verified numbers. Check Twilio's current rules.)
2. In `server/.env` set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`. Restart.
3. Settings → "SMS and phone calls": save your mobile number (with country code), switch on SMS and/or calls, press **Send test SMS / Place test call**.
4. Calls are only placed for meetings about to start and at-risk/overdue deadlines, never for ordinary reminders.

"Sent" here means **Twilio accepted the request**. Carrier delivery and whether you picked up are not confirmed.

### Calendar sync

- **Read-only feed (works now):** Settings → Calendar sync shows a private link (`/api/calendar.ics?token=…`) with your meetings (with alarms) and task deadlines. In Google Calendar: *Other calendars → + → From URL*. Google can only fetch it if DayPilot is reachable from the internet, so it needs hosting; apps refresh feeds on their own schedule (often hours). Keep the link private.
- **Two-way Google Calendar sync (not built):** create a Google Cloud project, enable the Calendar API, create an OAuth client, add `GOOGLE_CLIENT_ID/SECRET` to `.env`, then add an OAuth callback route and a sync job that maps meetings to Calendar events (store the refresh token encrypted). The meeting table already has everything a sync needs; ask for this as the next step.

## Security notes

- No secrets are in the frontend. Keys live only in `server/.env` (git-ignored) and are never returned by the API.
- **Login:** set `APP_PASSWORD` (8+ characters) in `server/.env` or your host's dashboard and every API call needs a sign-in (signed, HttpOnly, SameSite cookie valid for 30 days; wrong passwords are rate limited; changing the password signs all devices out). On your own computer it is optional because the server only listens on `localhost`.
- **Safe by default:** if `HOST` is anything other than localhost and `APP_PASSWORD` is missing, the server refuses to start.
- It is a single-user app (one password, one person's data). Multi-user accounts are in the roadmap below.
- The calendar feed and `/api/health` stay reachable without login; the feed is protected by a random token stored in the database.

## Deploying (needed for phone push, calendar feed and always-on reminders)

The project includes a `Dockerfile` and a `render.yaml`. You need a host with a **persistent disk**, because the data is one SQLite file (a host with a wiped disk will lose your data).

**Render (about 5 minutes):**
1. Put the `daypilot` folder in a GitHub repository (private is fine).
2. Render dashboard → **New → Blueprint** → select the repo. It reads `render.yaml` (Docker, 1 GB disk at `/data`, health check).
3. When asked, enter `APP_PASSWORD`. Leave the VAPID and Twilio fields empty until you need them.
4. After deploy open `https://<your-service>.onrender.com`, sign in, then Settings → set time zone and enable push.
   Render's disk requires a paid instance (the `starter` plan, roughly US$7/month at the time of writing; check current pricing). A free instance sleeps and has no disk, so reminders would not fire and data would be lost.

**Any other host / VPS:** `docker build -t daypilot . && docker run -d -p 3000:3000 -v daypilot-data:/data -e APP_PASSWORD='your-password' daypilot`, then put HTTPS in front (Caddy or the host's proxy).
Without Docker: `HOST=0.0.0.0 APP_PASSWORD=... TRUST_PROXY=1 npm start`.

## From personal tool to a paid product (roadmap, not built)

1. **Accounts:** add sign-up/login, a `user_id` on every table, per-user settings and calendar tokens.
2. **Database:** move SQLite to Postgres for multiple users; run the reminder engine as a background worker.
3. **Hosting + HTTPS:** deploy (above) with a domain, backups and error monitoring.
4. **Payments:** for India, Razorpay subscriptions (UPI/cards); for international, Stripe. Free plan = in-app reminders; paid plan = push, SMS/call credits, calendar sync.
5. **Costs:** SMS/calls cost money per message — meter them and pass the cost into the plan.
6. **Legal basics:** privacy policy, terms, data-deletion path (you will store people's schedules and phone numbers).

## Project layout

```
server/src   tz.js (time zones) · db.js (schema, settings) · items.js (tasks/meetings/search)
             reminders.js · engine.js (30 s proactive checks) · briefing.js (today/tomorrow/summary)
             parser.js (quick capture) · notify.js (channels) · ics.js · app.js (routes) · index.js
server/test  parser + API/engine/integration tests (`npm test`)
client/src   App.jsx · QuickCapture.jsx · ItemForms.jsx · pages/ (Today, Tomorrow, ListPage, Summary, Settings)
```
