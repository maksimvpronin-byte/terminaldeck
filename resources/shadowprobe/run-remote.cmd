@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-remote.ps1" %*
exit /b %ERRORLEVEL%
