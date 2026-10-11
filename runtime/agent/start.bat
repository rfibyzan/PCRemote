@echo off
cd /d "%~dp0"
set PCREMOTE_TRAY=1
title PC Remote agent
:retry
node src\index.js
if %ERRORLEVEL% EQU 0 goto :done
echo PC Remote crashed (%ERRORLEVEL%) — restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto retry
:done
