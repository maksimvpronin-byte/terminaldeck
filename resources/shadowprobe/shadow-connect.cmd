@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0shadow-connect.ps1" %*
exit /b %ERRORLEVEL%
