# The desktop tool's hands and eyes on Windows: screenshots, mouse, keyboard
# and window focus through user32 and System.Drawing.
#
# desktop-mcp.js keeps one of these running and talks JSON lines over stdio:
# each request {"id":n,"cmd":"...",...} gets one reply {"id":n,"ok":true,
# "result":...} or {"id":n,"ok":false,"error":"..."}. Coordinates here are
# physical screen pixels; the MCP server maps them to and from screenshots.
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI, and
# requests escape non-ASCII text as \u sequences.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class AgentDeskDisplay {
  public int Index { get; set; }
  public string Name { get; set; }
  public bool Primary { get; set; }
  public int X { get; set; }
  public int Y { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
}

public class AgentDeskWindow {
  public long Handle { get; set; }
  public string Title { get; set; }
  public string Process { get; set; }
  public bool Minimized { get; set; }
  public bool Focused { get; set; }
  public int X { get; set; }
  public int Y { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
}

public static class AgentDeskDesktop {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_RETURN = 0x0D, VK_TAB = 0x09;

  public static void Init() {
    // Physical pixels everywhere, so screenshots and the cursor agree on every monitor.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
  }

  static void Send(List<INPUT> inputs) {
    if (inputs.Count == 0) return;
    INPUT[] array = inputs.ToArray();
    uint sent = SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
    if (sent != array.Length) throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + "). An elevated window may have focus, or the screen is locked.");
  }

  static INPUT Mouse(uint flags, int data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = unchecked((uint)data);
    return input;
  }

  static bool IsExtended(ushort vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D
      || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5 || vk == 0x2C;
  }

  static INPUT Key(ushort vk, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
    return input;
  }

  static INPUT Unicode(char ch, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wScan = ch;
    input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return input;
  }

  public static void MoveTo(int x, int y) {
    if (!SetCursorPos(x, y)) throw new Exception("Could not move the mouse");
  }

  static uint[] ButtonFlags(string button) {
    if (button == "right") return new uint[] { MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP };
    if (button == "middle") return new uint[] { MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP };
    return new uint[] { MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP };
  }

  static void HoldKeys(ushort[] keys, bool up) {
    List<INPUT> inputs = new List<INPUT>();
    if (up) { for (int i = keys.Length - 1; i >= 0; i--) inputs.Add(Key(keys[i], true)); }
    else { foreach (ushort vk in keys) inputs.Add(Key(vk, false)); }
    Send(inputs);
  }

  public static void Click(int x, int y, string button, int count, ushort[] hold) {
    MoveTo(x, y);
    Thread.Sleep(40);
    uint[] flags = ButtonFlags(button);
    HoldKeys(hold, false);
    try {
      for (int i = 0; i < count; i++) {
        Send(new List<INPUT> { Mouse(flags[0], 0), Mouse(flags[1], 0) });
        if (i < count - 1) Thread.Sleep(60);
      }
    } finally {
      HoldKeys(hold, true);
    }
  }

  public static void Drag(int x1, int y1, int x2, int y2, string button) {
    uint[] flags = ButtonFlags(button);
    MoveTo(x1, y1);
    Thread.Sleep(60);
    Send(new List<INPUT> { Mouse(flags[0], 0) });
    try {
      const int steps = 20;
      for (int i = 1; i <= steps; i++) {
        Thread.Sleep(15);
        MoveTo(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      }
      Thread.Sleep(60);
    } finally {
      Send(new List<INPUT> { Mouse(flags[1], 0) });
    }
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    MoveTo(x, y);
    Thread.Sleep(40);
    // Positive wheel data scrolls up / right; one notch is 120.
    for (int i = 0; i < Math.Abs(dy); i++) { Send(new List<INPUT> { Mouse(MOUSEEVENTF_WHEEL, dy > 0 ? -120 : 120) }); Thread.Sleep(20); }
    for (int i = 0; i < Math.Abs(dx); i++) { Send(new List<INPUT> { Mouse(MOUSEEVENTF_HWHEEL, dx > 0 ? 120 : -120) }); Thread.Sleep(20); }
  }

  public static void TypeText(string text) {
    foreach (char ch in text) {
      List<INPUT> inputs = new List<INPUT>();
      if (ch == '\r') continue;
      if (ch == '\n') { inputs.Add(Key(VK_RETURN, false)); inputs.Add(Key(VK_RETURN, true)); }
      else if (ch == '\t') { inputs.Add(Key(VK_TAB, false)); inputs.Add(Key(VK_TAB, true)); }
      else { inputs.Add(Unicode(ch, false)); inputs.Add(Unicode(ch, true)); }
      Send(inputs);
      Thread.Sleep(4);
    }
  }

  /** The virtual key (and whether Shift is needed) for one character on the current layout. */
  public static int[] KeyForChar(char ch) {
    short scan = VkKeyScanW(ch);
    if (scan == -1) throw new Exception("No key for '" + ch + "' on this keyboard layout");
    return new int[] { scan & 0xFF, (scan >> 8) & 1 };
  }

  public static void PressKeys(ushort[] keys) {
    List<INPUT> inputs = new List<INPUT>();
    foreach (ushort vk in keys) inputs.Add(Key(vk, false));
    for (int i = keys.Length - 1; i >= 0; i--) inputs.Add(Key(keys[i], true));
    Send(inputs);
  }

  public static List<AgentDeskDisplay> Displays() {
    List<AgentDeskDisplay> list = new List<AgentDeskDisplay>();
    Screen[] screens = Screen.AllScreens;
    // Primary first, then left to right, so index 0 is always the main display.
    Array.Sort(screens, delegate (Screen a, Screen b) {
      if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
      return a.Bounds.X != b.Bounds.X ? a.Bounds.X.CompareTo(b.Bounds.X) : a.Bounds.Y.CompareTo(b.Bounds.Y);
    });
    for (int i = 0; i < screens.Length; i++) {
      Rectangle b = screens[i].Bounds;
      list.Add(new AgentDeskDisplay { Index = i, Name = screens[i].DeviceName, Primary = screens[i].Primary, X = b.X, Y = b.Y, Width = b.Width, Height = b.Height });
    }
    return list;
  }

  static void DrawCursor(Graphics g, int left, int top) {
    CURSORINFO info = new CURSORINFO();
    info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref info) || info.flags != 1 || info.hCursor == IntPtr.Zero) return;
    ICONINFO icon;
    int hx = 0, hy = 0;
    if (GetIconInfo(info.hCursor, out icon)) {
      hx = icon.xHotspot;
      hy = icon.yHotspot;
      if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
      if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
    }
    IntPtr hdc = g.GetHdc();
    try { DrawIconEx(hdc, info.ptScreenPos.x - left - hx, info.ptScreenPos.y - top - hy, info.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
    finally { g.ReleaseHdc(hdc); }
  }

  /** Captures a screen rectangle, scales it to outW x outH and returns base64 JPEG. */
  public static string Capture(int left, int top, int width, int height, int outW, int outH, bool cursor, long quality) {
    using (Bitmap full = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) {
        g.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        if (cursor) { try { DrawCursor(g, left, top); } catch { } }
      }
      Bitmap output = full;
      if (outW != width || outH != height) {
        output = new Bitmap(outW, outH, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(output)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g.SmoothingMode = SmoothingMode.HighQuality;
          g.DrawImage(full, new Rectangle(0, 0, outW, outH));
        }
      }
      try {
        ImageCodecInfo jpeg = null;
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) if (codec.FormatID == ImageFormat.Jpeg.Guid) jpeg = codec;
        EncoderParameters parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (MemoryStream stream = new MemoryStream()) {
          output.Save(stream, jpeg, parameters);
          return Convert.ToBase64String(stream.ToArray());
        }
      } finally {
        if (output != full) output.Dispose();
      }
    }
  }

  static string Title(IntPtr hWnd) {
    int length = GetWindowTextLengthW(hWnd);
    if (length <= 0) return "";
    StringBuilder text = new StringBuilder(length + 1);
    GetWindowTextW(hWnd, text, text.Capacity);
    return text.ToString();
  }

  /** Top-level windows a person would see in the taskbar or Alt+Tab, front to back. */
  public static List<AgentDeskWindow> Windows() {
    List<AgentDeskWindow> list = new List<AgentDeskWindow>();
    IntPtr foreground = GetForegroundWindow();
    Dictionary<uint, string> names = new Dictionary<uint, string>();
    EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      string title = Title(hWnd);
      if (title.Length == 0) return true;
      long exStyle = GetWindowLongPtr(hWnd, -20).ToInt64();
      if ((exStyle & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
      if (GetWindow(hWnd, 4) != IntPtr.Zero && (exStyle & 0x40000) == 0) return true; // owned, not WS_EX_APPWINDOW
      int cloaked = 0;
      try { DwmGetWindowAttribute(hWnd, 14, out cloaked, 4); } catch { }
      if (cloaked != 0) return true;
      RECT rect;
      GetWindowRect(hWnd, out rect);
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      string name;
      if (!names.TryGetValue(pid, out name)) {
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { name = ""; }
        names[pid] = name;
      }
      list.Add(new AgentDeskWindow {
        Handle = hWnd.ToInt64(), Title = title, Process = name, Minimized = IsIconic(hWnd), Focused = hWnd == foreground,
        X = rect.left, Y = rect.top, Width = rect.right - rect.left, Height = rect.bottom - rect.top,
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Focus(long handle) {
    IntPtr hWnd = new IntPtr(handle);
    if (!IsWindow(hWnd)) throw new Exception("That window no longer exists");
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
    // Windows only lets the foreground process hand focus over; a tapped Alt counts as user input.
    Send(new List<INPUT> { Key(VK_MENU, false), Key(VK_MENU, true) });
    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);
    Thread.Sleep(150);
    return GetForegroundWindow() == hWnd;
  }
}
'@

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms, System.Drawing
[AgentDeskDesktop]::Init()

function Keys($list) {
  return [uint16[]]@($list | ForEach-Object { [uint16]$_ })
}

function Invoke-Request($request) {
  switch ($request.cmd) {
    'displays' { return @{ items = [AgentDeskDesktop]::Displays().ToArray() } }
    'capture' {
      $data = [AgentDeskDesktop]::Capture($request.x, $request.y, $request.width, $request.height, $request.outWidth, $request.outHeight, [bool]$request.cursor, [long]$request.quality)
      return @{ data = $data }
    }
    'move' { [AgentDeskDesktop]::MoveTo($request.x, $request.y); return $null }
    'click' { [AgentDeskDesktop]::Click($request.x, $request.y, [string]$request.button, $request.count, (Keys $request.hold)); return $null }
    'drag' { [AgentDeskDesktop]::Drag($request.x1, $request.y1, $request.x2, $request.y2, [string]$request.button); return $null }
    'scroll' { [AgentDeskDesktop]::Scroll($request.x, $request.y, $request.dx, $request.dy); return $null }
    'type' { [AgentDeskDesktop]::TypeText([string]$request.text); return $null }
    'keyForChar' { $k = [AgentDeskDesktop]::KeyForChar([char][string]$request.char); return @{ vk = $k[0]; shift = [bool]$k[1] } }
    'keys' { [AgentDeskDesktop]::PressKeys((Keys $request.keys)); return $null }
    'windows' { return @{ items = [AgentDeskDesktop]::Windows().ToArray() } }
    'focus' { return @{ focused = [AgentDeskDesktop]::Focus([long]$request.handle) } }
    default { throw "Unknown command: $($request.cmd)" }
  }
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $result = Invoke-Request $request
    $reply = @{ id = $id; ok = $true; result = $result }
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
    $reply = @{ id = $id; ok = $false; error = $message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
