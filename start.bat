@echo off
setlocal
cd /d "%~dp0"
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 (
  echo FMEMate Project Pulse: http://127.0.0.1:8000
  echo Keep this window open. Press Ctrl+C to stop.
  py -3 server.py %*
  goto :end
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 (
  echo FMEMate Project Pulse: http://127.0.0.1:8000
  echo Keep this window open. Press Ctrl+C to stop.
  python server.py %*
  goto :end
)
echo Python 3.10 or newer is required.
echo Install Python from https://www.python.org/downloads/ and enable Add Python to PATH.
:end
pause
endlocal
