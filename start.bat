@echo off
rem One-click start for Windows. Installs and builds on first run, then opens the app.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get version 22.13 or newer from https://nodejs.org & pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || (echo Your Node.js is too old. DayPilot needs 22.13 or newer: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo First run: installing, about a minute... & call npm install --no-audit --no-fund)
if not exist client\dist\index.html (echo Building the app... & call npm run build)
start "" http://localhost:3000
echo DayPilot is running at http://localhost:3000  (close this window to stop)
call npm run start -w server
