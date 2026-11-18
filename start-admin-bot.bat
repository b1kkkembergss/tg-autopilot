@echo off
rem tg-autopilot admin bot launcher
title tg-autopilot admin
cd /d "%~dp0"
if not exist logs mkdir logs

echo ============================================
echo   tg-autopilot: admin bot
echo ============================================
echo.
echo Make sure the Happ VPN connection is active.
echo.

:loop
"C:\Program Files\nodejs\node.exe" src/admin_bot.js >> logs\admin.log 2>&1
echo.
echo Admin bot stopped. Restarting in 5 seconds... (Ctrl+C to exit)
%SystemRoot%\System32\timeout.exe /t 5 /nobreak >nul
goto loop