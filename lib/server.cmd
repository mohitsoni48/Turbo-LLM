@echo off
REM Internal: runs the SELECTED model's llama-server in the foreground.
REM Used by start.cmd's server window and by the ComfyUI VRAM gate.
REM Do not run directly for normal use - use start.cmd (it also frees VRAM,
REM starts Open WebUI and the idle watchdog).
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0llama.ps1" server
