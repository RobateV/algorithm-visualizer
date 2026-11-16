@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-bridge.ps1" status
node "%~dp0browser-relay.mjs" --status
pause
