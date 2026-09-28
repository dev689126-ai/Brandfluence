@echo off
REM Brandfluence - deploy to Catalyst (Development). Secrets come from secrets.local.json.
cd /d %~dp0
where catalyst >nul 2>nul || call npm install -g zcatalyst-cli
if not exist secrets.local.json (
  echo secrets.local.json is missing. Copy secrets.example.json to secrets.local.json and fill in your values.
  pause
  exit /b 1
)
cd functions\brandfluence_api && call npm install --omit=dev && cd ..\..
cd functions\bf_scheduler && call npm install --omit=dev && cd ..\..
node scripts\build-auth-css.js
node scripts\with-secrets.js catalyst deploy -p 5666000000546001
if errorlevel 1 (echo. & echo DEPLOY FAILED - send a screenshot of the error to Claude. & pause & exit /b 1)
echo.
echo DEPLOYED: https://brandfluence-60027750675.development.catalystserverless.in/app/index.html
pause
