@echo off
rem Start the WeChat sidecar.
rem
rem Two things must be true before this works:
rem   1. A WeChat desktop client is running and signed in, in *this* interactive desktop session
rem      (UI automation cannot see a window from another session, a service, or a detached RDP session).
rem   2. `wxautox4` is installed in the Python below and you hold a licence for it. This repository
rem      ships no circumvented build: without a licence the backend reports `available:false` with a
rem      reason instead of attaching.
rem
rem Everything the sidecar prints goes to bridge.log next to this file.
setlocal

rem --- set these for your machine -------------------------------------------
set "PY=python"
set "TOKEN_FILE=%~dp0..\secrets\wxbridge.token"
rem -------------------------------------------------------------------------

set "SERVER=%~dp0wxauto-bridge\server.py"
set "LOG=%~dp0bridge.log"

if not exist "%SERVER%" (
  echo [wxbridge] server not found: %SERVER% >>"%LOG%"
  exit /b 1
)
if not exist "%TOKEN_FILE%" (
  echo [wxbridge] %DATE% %TIME% token file not found: %TOKEN_FILE% >>"%LOG%"
  echo [wxbridge] write a random token there, then restrict it: icacls "%TOKEN_FILE%" /inheritance:r /grant:r "%%USERNAME%%:R"
  exit /b 1
)

rem The token is read from the file: never written on a command line, never logged.
set /p WXBRIDGE_TOKEN=<"%TOKEN_FILE%"
echo [wxbridge] %DATE% %TIME% starting pc-uia on http://127.0.0.1:8787 >>"%LOG%"
"%PY%" "%SERVER%" --backend pc-uia --port 8787 >>"%LOG%" 2>&1
echo [wxbridge] %DATE% %TIME% stopped, exit=%ERRORLEVEL% >>"%LOG%"
