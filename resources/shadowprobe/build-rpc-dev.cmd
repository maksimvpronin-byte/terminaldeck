@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-rpc.ps1" %*
exit /b %ERRORLEVEL%
