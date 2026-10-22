@echo off
REM Amitek Sales Employee - one-time setup on Windows.
REM Double-click this file. It only needs to be run once.
setlocal
cd /d "%~dp0"

echo ===============================================
echo   Amitek Sales Employee - setup
echo ===============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed.
  echo.
  echo Install it from https://www.python.org/downloads/
  echo IMPORTANT: on the first screen tick "Add python.exe to PATH".
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Found Python %PYVER%
echo.

if not exist ".venv\" (
  echo Creating a private Python folder for this bot...
  python -m venv .venv
  if errorlevel 1 (
    echo Could not create it. Tell Claude what this screen says.
    pause
    exit /b 1
  )
)

echo Installing what the bot needs. This takes a minute or two...
call .venv\Scripts\python.exe -m pip install --quiet --upgrade pip
call .venv\Scripts\python.exe -m pip install --quiet -r requirements.txt
if errorlevel 1 (
  echo Install failed. Tell Claude what this screen says.
  pause
  exit /b 1
)
echo Done.
echo.

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo ===============================================
  echo   NOW FILL IN YOUR DETAILS
  echo ===============================================
  echo A file called  .env  has been created in this folder.
  echo Opening it in Notepad. Fill in every blank line, save, and close it.
  echo.
  echo You will need:
  echo   - your Supabase database connection string and password
  echo   - WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN from BlueTick
  echo   - your Claude API key
  echo.
  pause
  notepad .env
) else (
  echo .env already exists, leaving it alone.
)

echo.
echo Setup finished. Start the bot by double-clicking  start.bat
echo.
pause
