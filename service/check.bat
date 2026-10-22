@echo off
REM Tests the database connection and explains what is wrong.
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Not set up yet. Run setup_fix.bat first.
  pause
  exit /b 1
)
echo.
".venv\Scripts\python.exe" -m scripts.check_db
echo.
echo (Also saved to check_log.txt)
echo.
pause
