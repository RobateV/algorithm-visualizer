@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-bridge.ps1" start
if errorlevel 1 pause
