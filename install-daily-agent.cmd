@echo off
REM ===========================================================================
REM  Run this ONCE. After that the agent starts by itself every day at 2pm.
REM
REM  The daily-command approach works but depends on somebody remembering, and
REM  a sender that only runs when remembered is a sender that quietly stops.
REM  This registers a Windows Scheduled Task instead, so the machine does the
REM  remembering.
REM
REM  Right-click this file and choose "Run as administrator".
REM ===========================================================================

cd /d "%~dp0"

echo.
echo   Registering the daily sending agent for 2:00 PM...
echo.

REM /F replaces any previous copy, so running this twice is harmless rather
REM than leaving two tasks fighting over the same queue.
schtasks /Create ^
  /TN "BizBuySell Sending Agent" ^
  /TR "\"%~dp0run-agent.cmd\"" ^
  /SC DAILY ^
  /ST 14:00 ^
  /RL HIGHEST ^
  /F

if errorlevel 1 (
  echo.
  echo   FAILED - this needs administrator rights.
  echo   Right-click this file and choose "Run as administrator".
) else (
  echo.
  echo   Done. The agent now starts every day at 2:00 PM by itself.
  echo.
  echo   To stop it permanently:
  echo     schtasks /Delete /TN "BizBuySell Sending Agent" /F
  echo.
  echo   To run it right now without waiting:
  echo     schtasks /Run /TN "BizBuySell Sending Agent"
)
echo.
pause
