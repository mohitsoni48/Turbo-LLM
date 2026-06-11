@echo off
REM ============================================================================
REM  STOP the local LLM stack (the ONE file to stop).
REM  Kills the idle watchdog, llama-server (frees VRAM), and Open WebUI.
REM ============================================================================
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0lib\llama.ps1" stop
timeout /t 3 >nul
