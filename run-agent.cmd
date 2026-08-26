@echo off
REM ---------------------------------------------------------------------------
REM  BizBuySell sending agent.
REM
REM  Railway cannot reach BizBuySell — its IP is refused — so the sending runs
REM  here instead, from a connection the site accepts. The server still does the
REM  finding, queueing and tracking; this only sends.
REM
REM  Double-click to run it. Leave the window open; closing it stops sending and
REM  hands any unsent listings back to the queue.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
title BizBuySell sending agent
echo Starting the sending agent. Close this window to stop.
echo Chrome runs off-screen - nothing will appear in front of you.
echo Log: %~dp0agent.log
echo.

REM Checked rather than assumed. A missing node_modules - after a fresh clone,
REM or a half-finished install - otherwise prints a wall of red that reads like
REM a broken agent rather than a missing dependency.
if not exist "node_modules\" (
  echo First run - installing dependencies, this takes a minute...
  call npm install --silent
  echo.
)
:loop
call npm run agent
echo.
echo Agent exited. Restarting in 60 seconds — close this window to stop.
timeout /t 60 /nobreak >nul
goto loop
