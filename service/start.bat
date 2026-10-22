@echo off
REM Starts the bot. Leave this window open - closing it stops the bot.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Not set up yet. Run setup_windows.bat first.
  pause
  exit /b 1
)
if not exist ".env" (
  echo No .env file. Run setup_windows.bat first.
  pause
  exit /b 1
)

echo ===============================================
echo   Amitek Sales Employee is starting
echo ===============================================
echo.
echo   Check it is alive:  http://localhost:8000/health
echo   See what it knows:  http://localhost:8000/api/status
echo.
echo   Keep this window open. Closing it stops the bot.
echo.

.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
pause
