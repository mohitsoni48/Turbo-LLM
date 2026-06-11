@echo off
REM ============================================================================
REM  START the local LLM stack (the ONE file to run).
REM  Loads the model currently selected in models.json (change it with config.cmd):
REM    - frees VRAM (lms unload --all)
REM    - launches llama-server in its own window  -> http://127.0.0.1:8080/v1
REM    - starts Open WebUI                         -> http://127.0.0.1:3000
REM    - arms the idle watchdog (auto-stop after the configured idle TTL)
REM  Stop everything with stop.cmd.
REM ============================================================================
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0lib\llama.ps1" start
timeout /t 6 >nul
