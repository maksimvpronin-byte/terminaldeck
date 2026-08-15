// ShadowHost — shows a Windows shadow session inside a TerminalDeck tab.
//
// Shadowing is not RDP on 3389 and no client TerminalDeck can embed speaks it,
// so the picture comes from mstsc. This process adopts mstsc's window and keeps
// it sitting exactly over the tab, so what the user sees is a tab.
//
// Why a separate process at all: SetParent across processes ties the two
// threads' input queues together, so a hung mstsc hangs whoever owns the parent
// window. Here that is this process and nothing else.
//
// Why the window is *owned* by TerminalDeck rather than a child of it: an owned
// window floats above its owner and minimises with it, but the tie is not an
// input-queue attachment. Parenting into Electron's own HWND would put the
// attachment right back, transitively, and the isolation above would be a
// fiction.
//
// Talks JSON lines on stdin and stdout. One line, one message; nothing is
// buffered waiting for a matching brace.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Native {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", SetLastError = true)] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public const int GWL_STYLE = -16;
  public const int GWLP_HWNDPARENT = -8;
  public const int WS_CHILD = 0x40000000;
  public const int WS_POPUP = unchecked((int)0x80000000);
  public const int WS_CAPTION = 0x00C00000;
  public const int WS_THICKFRAME = 0x00040000;

  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_FRAMECHANGED = 0x0020;

  // Starting the viewer under the host's account. Only the network identity is
  // replaced, which is what `runas /netonly` does: the process still runs as the
  // signed-in user, and the account need not exist on this machine.
  public const uint LOGON_NETCREDENTIALS_ONLY = 0x00000002;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessWithLogonW(
    string username, string domain, string password, uint logonFlags,
    string applicationName, StringBuilder commandLine, uint creationFlags,
    IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInfo);

  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);

  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr rect, IntPtr region, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  public const int WM_ACTIVATE = 0x0006;
  public const int WM_SETFOCUS = 0x0007;
  public const uint RDW_INVALIDATE = 0x0001;
  public const uint RDW_ERASE = 0x0004;
  public const uint RDW_ALLCHILDREN = 0x0080;
  public const uint RDW_UPDATENOW = 0x0100;
  public const uint RDW_FRAME = 0x0400;
}

/// The frame mstsc's window lives in. Frameless: the tab already has a border.
class HostForm : Form {
  public HostForm() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(27, 29, 33);
    Bounds = new Rectangle(-32000, -32000, 100, 100); // off-screen until placed
  }

  /// Never steals focus when it appears: the tab decides what is focused.
  protected override bool ShowWithoutActivation { get { return true; } }

  /// <summary>Hands the keyboard on to the session as soon as this frame has it.</summary>
  /// <remarks>
  /// Clicking the pane activates this window, and without this the keyboard
  /// stops here — the frame holds it and the viewer inside never sees a
  /// keystroke. What that looked like: keys pressed over a shadow session
  /// arrived at whatever the app had focused instead, so Ctrl+Alt+End typed at
  /// one session opened the security screen on another.
  ///
  /// The viewer is a window of another process, and adopting it attached the two
  /// input queues, which is what makes handing focus across possible at all.
  /// </remarks>
  protected override void WndProc(ref Message m) {
    base.WndProc(ref m);
    if (m.Msg == Native.WM_ACTIVATE || m.Msg == Native.WM_SETFOCUS) Program.FocusSession();
  }
}

static class Program {
  static HostForm form;
  static Process viewer;
  static IntPtr adopted = IntPtr.Zero;
  static readonly object gate = new object();

  [STAThread]
  static int Main() {
    // Both pipes carry UTF-8, because the app on the other end writes it. Left
    // to itself .NET decodes a redirected stream in the machine's OEM code page,
    // which turns a Cyrillic account name into one that does not exist — and the
    // only symptom is the host refusing the viewer.
    var utf8 = new UTF8Encoding(false);
    Console.SetIn(new StreamReader(Console.OpenStandardInput(), utf8));
    Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true });

    Application.EnableVisualStyles();
    form = new HostForm();
    form.CreateControl();
    var _ = form.Handle; // force the window into existence before any command

    var reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();

    Application.Run();
    Cleanup();
    return 0;
  }

  // --- talking to TerminalDeck ---------------------------------------------

  static void Send(string json) {
    lock (gate) {
      Console.Out.WriteLine(json);
      Console.Out.Flush();
    }
  }

  static void Event(string name, string detail) {
    Send("{\"event\":\"" + name + "\",\"detail\":" + Quote(detail) + "}");
  }

  static string Quote(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  /// Enough of a JSON reader for messages this process defines itself. A real
  /// parser would be a dependency, and every field here is a bare number,
  /// string or boolean written by one known sender.
  static string Field(string json, string name) {
    int at = json.IndexOf("\"" + name + "\"", StringComparison.Ordinal);
    if (at < 0) return null;
    at = json.IndexOf(':', at);
    if (at < 0) return null;
    at++;
    while (at < json.Length && json[at] == ' ') at++;
    if (at >= json.Length) return null;

    if (json[at] == '"') {
      var b = new StringBuilder();
      for (int i = at + 1; i < json.Length; i++) {
        if (json[i] == '\\' && i + 1 < json.Length) { b.Append(json[++i]); continue; }
        if (json[i] == '"') break;
        b.Append(json[i]);
      }
      return b.ToString();
    }
    int end = at;
    while (end < json.Length && json[end] != ',' && json[end] != '}') end++;
    return json.Substring(at, end - at).Trim();
  }

  static int Int(string json, string name, int fallback) {
    int v;
    var raw = Field(json, name);
    return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : fallback;
  }

  static bool Bool(string json, string name) {
    return Field(json, name) == "true";
  }

  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var json = line;
      // Everything that touches a window has to run on the thread that owns it.
      form.BeginInvoke((MethodInvoker)delegate { Handle(json); });
    }
    // stdin closed: TerminalDeck is gone, and so is any reason to stay.
    form.BeginInvoke((MethodInvoker)delegate { Application.ExitThread(); });
  }

  static void Handle(string json) {
    try {
      switch (Field(json, "action")) {
        case "start": Start(json); break;
        case "bounds": Bounds(json); break;
        // Fitting again on the way back: the pane may have been resized while
        // this was hidden, and a hidden window is not re-laid-out when it moves.
        case "show": form.Visible = true; Fit(); break;
        case "hide": form.Visible = false; break;
        case "stop": Application.ExitThread(); break;
      }
    } catch (Exception e) {
      Event("error", e.Message);
    }
  }

  // --- the session ----------------------------------------------------------

  /// <summary>
  /// Starts the viewer, under the host's own account when one was given.
  /// </summary>
  /// <remarks>
  /// mstsc takes no credentials of its own. Shadowing authenticates over RPC
  /// with whatever identity the process already carries, so a viewer started by
  /// the signed-in user reaches a host that has never heard of them and is
  /// refused — which is why shadowing worked here only where the local account
  /// happened to match one the host knew.
  ///
  /// Only the network identity is replaced. The process still runs as the user
  /// who started it, nothing needs the account to exist on this machine, and no
  /// profile is loaded.
  /// </remarks>
  static Process Launch(string args, string user, string password) {
    var mstsc = Path.Combine(Environment.SystemDirectory, "mstsc.exe");
    if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(password)) {
      var info = new ProcessStartInfo(mstsc, args);
      info.UseShellExecute = false;
      return Process.Start(info);
    }

    // CreateProcessWithLogonW wants the domain apart from the name.
    string domain = null;
    var slash = user.IndexOf('\\');
    if (slash > 0) {
      domain = user.Substring(0, slash);
      user = user.Substring(slash + 1);
    }

    var command = new StringBuilder("\"" + mstsc + "\" " + args);
    var startup = new Native.STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));

    Native.PROCESS_INFORMATION created;
    if (!Native.CreateProcessWithLogonW(
          user, domain, password, Native.LOGON_NETCREDENTIALS_ONLY,
          mstsc, command, Native.CREATE_UNICODE_ENVIRONMENT,
          IntPtr.Zero, null, ref startup, out created)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    Native.CloseHandle(created.hThread);
    Native.CloseHandle(created.hProcess);
    return Process.GetProcessById(created.dwProcessId);
  }

  static void Start(string json) {
    var host = Field(json, "host");
    var session = Int(json, "sessionId", -1);
    if (string.IsNullOrEmpty(host) || session < 0) throw new Exception("start needs host and sessionId");

    // Owned, not parented: floats above TerminalDeck and minimises with it,
    // without joining its input queue. See the note at the top.
    var owner = new IntPtr(Int(json, "owner", 0));
    if (owner != IntPtr.Zero) Native.SetWindowLong(form.Handle, Native.GWLP_HWNDPARENT, owner.ToInt32());

    var control = Bool(json, "control");

    var args = "/v:" + host + " /shadow:" + session;
    if (control) args += " /control";
    if (Bool(json, "noPrompt")) args += " /noconsentprompt";

    viewer = Launch(args, Field(json, "user"), Field(json, "password"));
    viewer.EnableRaisingEvents = true;
    viewer.Exited += delegate {
      try { form.BeginInvoke((MethodInvoker)delegate { Event("ended", "the viewer closed"); }); } catch { }
    };

    var timer = new System.Windows.Forms.Timer();
    timer.Interval = 300;
    var deadline = DateTime.UtcNow.AddSeconds(90);
    timer.Tick += delegate {
      if (adopted != IntPtr.Zero) { timer.Stop(); return; }
      if (viewer.HasExited) {
        timer.Stop();
        Event("error", "the viewer closed before a session appeared");
        return;
      }
      if (DateTime.UtcNow > deadline) {
        timer.Stop();
        Event("error", "no session window appeared");
        return;
      }
      var found = FindSessionWindow((uint)viewer.Id);
      if (found != IntPtr.Zero) {
        timer.Stop();
        Adopt(found);
      }
    };
    timer.Start();
  }

  /// mstsc shows a small progress box first and the session only once the far
  /// end has agreed, so the first window is the wrong one. Size is what tells
  /// them apart.
  static IntPtr FindSessionWindow(uint pid) {
    IntPtr best = IntPtr.Zero;
    int bestArea = 0;
    Native.EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!Native.IsWindowVisible(h)) return true;
      uint owner;
      Native.GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      Native.RECT r;
      Native.GetWindowRect(h, out r);
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      if (w < 500 || ht < 300) return true;
      if (w * ht > bestArea) { bestArea = w * ht; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  static void Adopt(IntPtr child) {
    // A top-level window keeps its frame and ignores the parent's client area
    // until it is restyled as a child.
    int style = Native.GetWindowLong(child, Native.GWL_STYLE);
    style &= ~Native.WS_POPUP;
    style &= ~Native.WS_CAPTION;
    style &= ~Native.WS_THICKFRAME;
    style |= Native.WS_CHILD;
    Native.SetWindowLong(child, Native.GWL_STYLE, style);
    Native.SetParent(child, form.Handle);
    adopted = child;
    Fit();
    Event("ready", "session window adopted");
  }

  static void Bounds(string json) {
    form.Bounds = new Rectangle(
      Int(json, "x", 0), Int(json, "y", 0),
      Math.Max(1, Int(json, "w", 1)), Math.Max(1, Int(json, "h", 1)));
    Fit();
  }


  /// The session is shown at its own size and centred: mstsc will not scale a
  /// shadow session from outside the process, so stretching the window would
  /// crop the picture rather than fit it.
  static void Fit() {
    if (adopted == IntPtr.Zero || !Native.IsWindow(adopted)) return;
    Native.RECT r;
    Native.GetWindowRect(adopted, out r);
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    var area = form.ClientSize;
    int x = Math.Max(0, (area.Width - w) / 2);
    int y = Math.Max(0, (area.Height - h) / 2);
    Native.SetWindowPos(adopted, IntPtr.Zero, x, y, w, h,
      Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED);

    // Moving a window only invalidates what newly came into view, and the
    // viewer repaints just that. Without asking for the whole client area back,
    // a move leaves the picture in pieces: fresh strips where the window now is,
    // stale ones everywhere it used to be.
    Native.RedrawWindow(adopted, IntPtr.Zero, IntPtr.Zero,
      Native.RDW_INVALIDATE | Native.RDW_ERASE | Native.RDW_FRAME |
      Native.RDW_ALLCHILDREN | Native.RDW_UPDATENOW);
  }
  /// <summary>Gives the keyboard to the adopted session window.</summary>
  /// <remarks>
  /// A watched session has nothing to hand it to: mstsc without /control
  /// ignores input by design, so the keys go nowhere and no harm is done.
  /// </remarks>
  public static void FocusSession() {
    if (adopted == IntPtr.Zero || !Native.IsWindow(adopted)) return;
    Native.SetFocus(adopted);
  }

  static void Cleanup() {
    try {
    } catch { }
    try {
      if (viewer != null && !viewer.HasExited) { viewer.Kill(); viewer.WaitForExit(3000); }
    } catch { }
  }
}
