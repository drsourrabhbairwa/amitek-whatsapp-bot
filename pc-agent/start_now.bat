@echo off
REM Starts the watcher in this window. Close the window to stop it.
cd /d "%~dp0"
python -I amitek_autopilot.py
pause
