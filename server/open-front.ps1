param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Reveal
)
# Opens a file/folder (or reveals it in Explorer) and brings the new window to
# the front. A background server process has no right to take focus, so the
# window would otherwise open behind the app.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Front {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static List<long> Windows() {
    var list = new List<long>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && (GetWindowLong(h, -20) & 0x80) == 0) list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static void Raise(long handle) {
    var h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    // A synthetic Alt press lets this process take the foreground.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0003 | 0x0040); // topmost, then release it
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0003 | 0x0040);
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }
}
"@

$before = [Front]::Windows()

if ($Reveal) {
  Start-Process -FilePath explorer.exe -ArgumentList "/select,`"$Path`""
} else {
  Start-Process -FilePath explorer.exe -ArgumentList "`"$Path`""
}

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 150
  $new = [Front]::Windows() | Where-Object { $before -notcontains $_ }
  if ($new) {
    Start-Sleep -Milliseconds 200
    foreach ($h in $new) { [Front]::Raise($h) }
    break
  }
}
