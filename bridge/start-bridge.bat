@echo off
REM Hark Bridge launcher for Windows. Needs Node.js 18+ (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
title Hark Bridge
node bridge.js %*
pause
