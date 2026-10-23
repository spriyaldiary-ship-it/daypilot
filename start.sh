#!/usr/bin/env bash
# One-click start for macOS / Linux. Installs and builds on first run, then opens the app.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get version 22.13 or newer from https://nodejs.org and run this again."; exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Your Node.js is $(node -v). DayPilot needs 22.13 or newer: https://nodejs.org"; exit 1
fi

[ -d node_modules ] || { echo "First run: installing (about a minute)..."; npm install --no-audit --no-fund; }
[ -f client/dist/index.html ] || { echo "Building the app..."; npm run build; }

URL="http://localhost:${PORT:-3000}"
( sleep 2; (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true ) &
echo "DayPilot is running at $URL  (press Ctrl+C to stop)"
exec npm run start -w server
