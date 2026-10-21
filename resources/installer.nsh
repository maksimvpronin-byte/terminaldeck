; What the Windows installer does beyond electron-builder's own steps. Picked
; up by electron-builder by its name, from `buildResources`.
;
; The install folder goes on the user's PATH, so `TerminalDeck.exe -s web-01`
; works from any console. An update is the installer run again, so a copy
; installed before this existed gets it with its next update, and every update
; puts it back if it was taken off. A console already open keeps the PATH it
; started with; one opened afterwards has it.
;
; The user's PATH, under HKCU\Environment, not the machine's: no other account
; is touched, and no install needs to be elevated for it. It is read and
; written by PowerShell rather than here: NSIS cuts a string at its own length
; limit, and a long PATH written back through it would come back shortened.
; It is read without expanding the %VARIABLES% in it, and written back the
; same way, so the entries already there stay as they were written. The folder
; travels in an environment variable, not inside the command, so a path with
; an apostrophe in it cannot end the string it is in.

!include WinMessages.nsh

!define TD_POWERSHELL `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`

!macro customInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "TD_PATH_DIR", t "$INSTDIR")i'
  nsExec::ExecToLog `${TD_POWERSHELL} "$$d = $$env:TD_PATH_DIR.TrimEnd('\'); $$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p -split ';' | Where-Object { $$_ -ne '' }); if (-not ($$parts | Where-Object { $$_.TrimEnd('\') -ieq $$d })) { $$k.SetValue('Path', ((@($$parts) + $$d) -join ';'), 'ExpandString') }; $$k.Close()"`
  Pop $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; Taken off again on a real uninstall only. An update runs the old uninstaller
; first, and the install that follows would only have to put it back.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "TD_PATH_DIR", t "$INSTDIR")i'
    nsExec::ExecToLog `${TD_POWERSHELL} "$$d = $$env:TD_PATH_DIR.TrimEnd('\'); $$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $$true); if ($$k) { $$p = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p -split ';' | Where-Object { $$_ -ne '' }); $$keep = @($$parts | Where-Object { $$_.TrimEnd('\') -ine $$d }); if ($$keep.Count -ne $$parts.Count) { $$k.SetValue('Path', ($$keep -join ';'), 'ExpandString') }; $$k.Close() }"`
    Pop $0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${endIf}
!macroend
