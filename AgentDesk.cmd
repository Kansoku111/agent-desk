@echo off
rem Agent Desk launcher: installs dependencies on first run, then starts the app window.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :error
)
call npm start
if errorlevel 1 goto :error
exit /b 0
:error
echo.
echo Agent Desk failed to start. See the messages above.
pause
