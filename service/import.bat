@echo off
REM Load a lead file into the database.
REM Drag a CSV file onto this icon, or run it and type the path.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Not set up yet. Run setup_windows.bat first.
  pause
  exit /b 1
)

set "FILE=%~1"
if "%FILE%"=="" (
  echo Drag a CSV file onto this icon, or type its full path below.
  set /p FILE="CSV file: "
)
if "%FILE%"=="" (
  echo Nothing to import.
  pause
  exit /b 1
)

echo.
echo Checking the file first - nothing will be written yet.
echo.
.venv\Scripts\python.exe -m scripts.import_leads "%FILE%" --dry-run
echo.
set /p GO="Import these leads for real? (y/n): "
if /i not "%GO%"=="y" (
  echo Cancelled. Nothing was written.
  pause
  exit /b 0
)
echo.
.venv\Scripts\python.exe -m scripts.import_leads "%FILE%"
echo.
pause
