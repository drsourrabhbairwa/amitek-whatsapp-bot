@echo off
REM Amitek lead autopilot - one-time setup on this PC.
REM Makes Windows start the watcher at every login and keep it going, so after a power cut
REM or a restart it goes back to work on its own.

setlocal
cd /d "%~dp0"

echo.
echo   Amitek lead autopilot - setup
echo   =============================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo   Python was not found on this PC.
  echo   Install it from https://www.python.org/downloads/ and TICK "Add python.exe to PATH".
  echo   Then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist config.json (
  echo   First, the two things the watcher needs:
  echo.
  set /p WEBAPP="   1. Bot web app link (ends with /exec): "
  set /p PIN="   2. App PIN: "
  echo   3. Folder to watch. Press Enter for: %~dp0inbox
  set /p INBOX="      Folder: "
  if "%INBOX%"=="" set "INBOX=%~dp0inbox"
  > config.json echo {
  >> config.json echo   "webAppUrl": "%WEBAPP%",
  >> config.json echo   "pin": "%PIN%",
  >> config.json echo   "inbox": "%INBOX:\=\\%",
  >> config.json echo   "scanSeconds": 300
  >> config.json echo }
  echo.
  echo   Saved config.json
)

if not exist inbox mkdir inbox

echo   Checking the link and PIN...
python -I "%~dp0amitek_autopilot.py" --once
if errorlevel 1 (
  echo.
  echo   Setup stopped. Fix config.json and run this file again.
  pause
  exit /b 1
)

echo.
echo   Registering it to start at every login...
schtasks /Create /TN "Amitek lead autopilot" /SC ONLOGON /RL LIMITED /F ^
  /TR "\"%~dp0run_hidden.vbs\"" >nul
if errorlevel 1 (
  echo   Could not register the task. Start it by hand with start_now.bat instead.
) else (
  echo   Done. It will start by itself every time you log in.
  schtasks /Run /TN "Amitek lead autopilot" >nul 2>&1
  echo   Started now as well.
)

echo.
echo   Put your Excel or CSV lead files into:
type config.json | findstr inbox
echo.
echo   What happens next, by itself:
echo     - leads are sent to the bot
echo     - the bot files them into categories (Settings: AUTOPILOT = true)
echo     - an always-on welcome campaign greets them, inside the daily limit and the sending hours
echo     - people who never reply get the follow-ups you set in FOLLOWUP_STEPS
echo.
echo   Progress is written to autopilot.log in this folder.
echo.
pause
