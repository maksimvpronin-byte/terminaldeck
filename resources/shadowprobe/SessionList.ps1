<##
  Lists a host's sessions through the Terminal Services API.

  qwinsta would be shorter, but its status words are localised and it writes in
  the console OEM code page, which arrives through WinRM as mojibake — unreadable
  by a person and unparseable by a script. WTSEnumerateSessions returns the state
  as a number, so neither the host's language nor its code page can change the
  answer.
##>

$script:WtsSource = @'
using System;
using System.Runtime.InteropServices;

public static class TerminalDeckWts
{
  [StructLayout(LayoutKind.Sequential)]
  struct SessionInfo { public int SessionId; public IntPtr WinStationName; public int State; }

  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int WTSEnumerateSessionsW(IntPtr server, int reserved, int version, ref IntPtr sessions, ref int count);

  [DllImport("wtsapi32.dll")]
  static extern void WTSFreeMemory(IntPtr memory);

  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);

  public static string[] List()
  {
    IntPtr sessions = IntPtr.Zero;
    int count = 0;
    if (WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, ref sessions, ref count) == 0)
      throw new Exception("WTSEnumerateSessions failed with " + Marshal.GetLastWin32Error());

    try
    {
      string[] rows = new string[count];
      int size = Marshal.SizeOf(typeof(SessionInfo));
      for (int i = 0; i < count; i++)
      {
        IntPtr at = new IntPtr(sessions.ToInt64() + (long)i * size);
        SessionInfo info = (SessionInfo)Marshal.PtrToStructure(at, typeof(SessionInfo));
        rows[i] = info.SessionId + "\t" + Marshal.PtrToStringUni(info.WinStationName)
          + "\t" + info.State + "\t" + UserName(info.SessionId);
      }
      return rows;
    }
    finally { WTSFreeMemory(sessions); }
  }

  static string UserName(int sessionId)
  {
    IntPtr buffer;
    int bytes;
    /* WTSUserName */
    if (!WTSQuerySessionInformationW(IntPtr.Zero, sessionId, 5, out buffer, out bytes)) return "";
    try { return Marshal.PtrToStringUni(buffer); }
    finally { WTSFreeMemory(buffer); }
  }
}
'@

# WTS_CONNECTSTATE_CLASS.
$script:WtsStateNames = @{
  0 = 'Active'; 1 = 'Connected'; 2 = 'ConnectQuery'; 3 = 'Shadow'; 4 = 'Disconnected'
  5 = 'Idle'; 6 = 'Listen'; 7 = 'Reset'; 8 = 'Down'; 9 = 'Init'
}

<#
  Returns one object per session, with Shadowable saying whether it is a valid
  shadow target at all. Only a session someone is signed in to and using can be
  shadowed: listeners, the services session and disconnected sessions cannot,
  and asking to shadow one of them yields an invitation to nothing.
#>
function Get-ShadowSession {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)] $Session)

  $rows = Invoke-Command -Session $Session -ScriptBlock {
    param($source)
    if (-not ('TerminalDeckWts' -as [type])) { Add-Type -TypeDefinition $source }
    [TerminalDeckWts]::List()
  } -ArgumentList $script:WtsSource

  foreach ($row in $rows) {
    $fields = $row -split "`t"
    $state = [int]$fields[2]
    [pscustomobject]@{
      Id         = [int]$fields[0]
      Station    = $fields[1]
      State      = $script:WtsStateNames[$state]
      User       = $fields[3]
      Shadowable = ($state -eq 0 -and -not [string]::IsNullOrWhiteSpace($fields[3]))
    }
  }
}
