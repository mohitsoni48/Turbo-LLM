@echo off
:: Self-elevate via UAC if not already running as Administrator.
net session >nul 2>&1
if %errorLevel% == 0 goto :run
echo Requesting Administrator privileges (UAC prompt will appear)...
powershell -ExecutionPolicy Bypass -NoProfile -Command "Start-Process cmd -Verb RunAs -Wait -ArgumentList '/c ""%~f0""'"
goto :eof

:run
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0lib\llama.ps1" fix-tdr
echo.
pause
