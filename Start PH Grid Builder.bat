@echo off
title PH Grid Builder
cd /d "%~dp0"

rem Use the portable Node.js if Node isn't installed system-wide
where npm.cmd >nul 2>nul
if errorlevel 1 set "PATH=%LOCALAPPDATA%\Programs\node-v24.21.0-win-x64;%PATH%"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo Installing dependencies - first run only...
  call npm.cmd install --no-fund --no-audit
)

echo.
echo Starting PH Grid Builder at http://localhost:5173
echo Close this window to stop it.
echo.
start "" http://localhost:5173
call npm.cmd run dev
pause
