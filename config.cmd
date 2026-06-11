@echo off
REM ============================================================================
REM  CONFIG (TUI): pick which model loads on start.cmd, and edit every launch
REM  parameter per model (ctx, n-cpu-moe, parallel, KV type, sampling, NextN,
REM  vision, reasoning) plus global settings (port, idle TTL, Open WebUI).
REM  Arrow keys to move, Enter to select, Esc to go back. Saves automatically.
REM ============================================================================
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0lib\llama.ps1" config
