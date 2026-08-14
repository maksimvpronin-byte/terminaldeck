@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-rpc.ps1" %*
exit /b %ERRORLEVEL%
