// Standalone probe for the documented RpcShadow2 ABI.
//
// Default mode only resolves the exports. `--call` is deliberately explicit:
// RpcShadow2 can create a real shadow invitation and may block on policy/user
// permission, so this executable is never started by TerminalDeck itself.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class Native {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern IntPtr LoadLibraryW(string name);

  [DllImport("kernel32.dll", ExactSpelling = true)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);

  [DllImport("kernel32.dll", ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool FreeLibrary(IntPtr module);

  [DllImport("winsta.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  public static extern IntPtr WinStationOpenServerW(string serverName);

  [DllImport("winsta.dll", ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool WinStationCloseServer(IntPtr server);

  // The parameter order and widths mirror MS-TSTS RpcShadow2. This is kept in
  // a process of its own until a real-host call confirms the undocumented
  // WinStation wrapper's ABI.
  [DllImport("winsta.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern int WinStationRcmShadow2(
    IntPtr server,
    uint targetSessionId,
    uint requestControl,
    uint requestPermission,
    out uint response,
    IntPtr invitation,
    uint invitationCapacity);

  // Some winsta.dll builds expose the RPC out-string as LPWSTR* even though
  // the public IDL prints LPWSTR. Keep this ABI trial explicit and isolated.
  [DllImport("winsta.dll", EntryPoint = "WinStationRcmShadow2", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern int WinStationRcmShadow2Pointer(
    IntPtr server,
    uint targetSessionId,
    uint requestControl,
    uint requestPermission,
    out uint response,
    IntPtr invitationSlot,
    uint invitationCapacity);
}

static class Program {
  const uint View = 0;
  const uint TakeControl = 1;
  const uint Silent = 0;
  const uint RequestPermission = 1;

  static int Main(string[] args) {
    if (args.Length == 0 || args[0] == "--resolve") return Resolve();
    if (args[0] != "--call" || args.Length < 2 || args.Length > 5) {
      Console.Error.WriteLine("Usage: ShadowProbe.exe [--resolve | --call <sessionId> [host] [control] [pointer]]");
      return 2;
    }

    uint session;
    if (!UInt32.TryParse(args[1], out session)) {
      Console.Error.WriteLine("sessionId must be an unsigned integer");
      return 2;
    }
    string host = args.Length >= 3 && !IsMode(args[2]) ? args[2] : null;
    bool control = HasMode(args, "control");
    bool pointer = HasMode(args, "pointer");
    return Call(session, host, control, pointer);
  }

  static bool IsMode(string value) {
    return String.Equals(value, "control", StringComparison.OrdinalIgnoreCase) ||
      String.Equals(value, "pointer", StringComparison.OrdinalIgnoreCase);
  }

  static bool HasMode(string[] args, string mode) {
    foreach (string arg in args) if (String.Equals(arg, mode, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }

  static int Resolve() {
    IntPtr module = Native.LoadLibraryW("winsta.dll");
    if (module == IntPtr.Zero) {
      Console.Error.WriteLine("winsta.dll could not be loaded");
      return 1;
    }
    try {
      string[] names = { "WinStationOpenServerW", "WinStationCloseServer", "WinStationRcmShadow2" };
      bool all = true;
      foreach (string name in names) {
        IntPtr address = Native.GetProcAddress(module, name);
        Console.WriteLine(name + ": " + (address == IntPtr.Zero ? "missing" : "0x" + address.ToInt64().ToString("X")));
        all = all && address != IntPtr.Zero;
      }
      return all ? 0 : 1;
    } finally {
      Native.FreeLibrary(module);
    }
  }

  static int Call(uint session, string host, bool control, bool pointer) {
    Console.WriteLine("Calling RpcShadow2: session=" + session + ", host=" + (host ?? "local") + ", mode=" + (control ? "control" : "view") + ", abi=" + (pointer ? "pointer" : "buffer"));
    IntPtr server = Native.WinStationOpenServerW(host == null ? null : "\\\\" + host);
    if (server == IntPtr.Zero) {
      Console.Error.WriteLine("WinStationOpenServerW returned null");
      return 3;
    }

    try {
      IntPtr invitation = Marshal.AllocHGlobal(pointer ? IntPtr.Size : 8192 * 2);
      uint response;
      try {
        for (int i = 0; i < (pointer ? IntPtr.Size : 8192 * 2); i++) Marshal.WriteByte(invitation, i, 0);
        int result = pointer
          ? Native.WinStationRcmShadow2Pointer(server, session, control ? TakeControl : View, Silent, out response, invitation, 8192)
          : Native.WinStationRcmShadow2(server, session, control ? TakeControl : View, Silent, out response, invitation, 8192);
        IntPtr textPointer = pointer ? Marshal.ReadIntPtr(invitation) : invitation;
        string text = textPointer == IntPtr.Zero ? "" : (Marshal.PtrToStringUni(textPointer) ?? "");
        Console.WriteLine("HRESULT=0x" + result.ToString("X8") + ", response=" + response + ", invitationChars=" + text.Length);
        if (result != 0) return result;
        Console.WriteLine(text);
        return 0;
      } finally {
        Marshal.FreeHGlobal(invitation);
      }
    } finally {
      Native.WinStationCloseServer(server);
    }
  }
}
