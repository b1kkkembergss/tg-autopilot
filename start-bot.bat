@echo off
rem tg-autopilot main bot launcher
title tg-autopilot
cd /d "%~dp0"
if not exist logs mkdir logs

echo ============================================
echo   tg-autopilot: main bot
echo ============================================
echo.
echo Make sure the Happ VPN connection is active.
echo.

:loop
"C:\Program Files\nodejs\node.exe" src/index.js >> logs\main.log 2>&1
echo.
echo Main bot stopped. Restarting in 5 seconds... (Ctrl+C to exit)
%SystemRoot%\System32\timeout.exe /t 5 /nobreak >nul
goto loop
