@echo off
REM Runs the agent with no visible window, for leaving it going in the
REM background. Stop it from Task Manager (look for "node"), or use
REM Task Scheduler if you registered it there.
cd /d "%~dp0"
powershell -WindowStyle Hidden -Command "Start-Process -FilePath cmd -ArgumentList '/c \"%~dp0run-agent.cmd\"' -WindowStyle Hidden"
echo Agent started in the background. Log: %~dp0agent.log
