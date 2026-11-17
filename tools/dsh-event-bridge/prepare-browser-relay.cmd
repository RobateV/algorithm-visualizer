@echo off
cd /d "%~dp0"
if not exist ".local-state\browser-relay.json" node browser-relay.mjs --init
if errorlevel 1 goto fail
node browser-relay.mjs --enable
if errorlevel 1 goto fail
echo Local relay configuration is ready. DSH execution remains controlled by policy.json.
echo Import .local-state\browser-relay.json into the extension. Do not upload this file.
pause
exit /b 0
:fail
echo Relay setup failed. No task was executed.
pause
exit /b 1
