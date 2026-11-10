param(
  [string]$Path = $env:AGENT_DESK_FILE_PATH,
  [switch]$Reveal
)
# Verify the requested Explorer location and report activation separately.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
  $item = Get-Item -LiteralPath $Path -Force
  # Windows PowerShell can return no item and no error for a missing literal
  # path under a directory whose name contains brackets.
  if ($null -eq $item) { throw 'The requested path no longer exists.' }
  if (!$Reveal -and !$item.PSIsContainer) {
    # ShellExecute uses the file association and reports launch errors. Do not
    # route files through explorer.exe, which hides failures from the caller.
    Start-Process -FilePath $item.FullName -ErrorAction Stop
    return
  }

  Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class Front {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attrs, out uint found);
  [DllImport("shell32.dll")]
  static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, IntPtr[] items, uint flags);
  [DllImport("shell32.dll")] static extern IntPtr ILFindLastID(IntPtr pidl);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(
    IntPtr h, uint msg, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FlashInfo info);

  [StructLayout(LayoutKind.Sequential)]
  struct FlashInfo {
    public uint Size;
    public IntPtr Handle;
    public uint Flags, Count, Timeout;
  }

  public static void Reveal(string folder, string target) {
    IntPtr folderId = IntPtr.Zero, targetId = IntPtr.Zero;
    uint attrs;
    try {
      Marshal.ThrowExceptionForHR(SHParseDisplayName(folder, IntPtr.Zero, out folderId, 0, out attrs));
      Marshal.ThrowExceptionForHR(SHParseDisplayName(target, IntPtr.Zero, out targetId, 0, out attrs));
      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(folderId, 1, new[] { ILFindLastID(targetId) }, 0));
    } finally {
      if (targetId != IntPtr.Zero) Marshal.FreeCoTaskMem(targetId);
      if (folderId != IntPtr.Zero) Marshal.FreeCoTaskMem(folderId);
    }
  }

  // Explorer can keep hidden CabinetWClass windows in ShellWindows and reuse
  // them for a selection. Activating one only raises what it owns (for
  // example a shell extension's popup), so visibility is checked as well.
  public static bool Shown(long handle) {
    return IsWindowVisible(new IntPtr(handle));
  }

  public static long VisibleForegroundHandle() {
    var h = GetForegroundWindow();
    return IsIconic(h) || !IsWindowVisible(h) ? 0 : h.ToInt64();
  }

  // This helper is a child of the server, not the foreground process, so a
  // plain SetForegroundWindow is refused by the foreground lock even right
  // after the user's click. Sharing the input queue of the window the user
  // clicked in (the Agent Desk page) lets Windows treat the request as coming
  // from that click. Unlike a synthetic Alt key, it sends no input to the app.
  static bool Activate(IntPtr h) {
    uint ignored;
    var current = GetCurrentThreadId();
    var foreground = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    var attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
    try {
      BringWindowToTop(h);
      return SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(current, foreground, false);
    }
  }

  public static bool Raise(long handle) {
    var h = new IntPtr(handle);
    if (!IsWindowVisible(h) && ShowWindowAsync(h, 5)) { // SW_SHOW
      var shown = Stopwatch.StartNew();
      while (!IsWindowVisible(h) && shown.ElapsedMilliseconds < 500) Thread.Sleep(15);
    }
    if (IsIconic(h) && ShowWindowAsync(h, 9)) { // SW_RESTORE
      // The foreground handle can change before the restore is processed.
      var wait = Stopwatch.StartNew();
      while (IsIconic(h) && wait.ElapsedMilliseconds < 500) Thread.Sleep(15);
    }
    if (VisibleForegroundHandle() == handle) return true;
    if (!IsIconic(h) && Activate(h)) {
      // Activation across input queues is asynchronous. WM_NULL lets Explorer
      // process the activation before we read the foreground handle.
      UIntPtr ignored;
      SendMessageTimeoutW(h, 0, UIntPtr.Zero, IntPtr.Zero, 2, 250, out ignored);
      if (VisibleForegroundHandle() == handle) return true;
    }
    var flash = new FlashInfo { Size = (uint)Marshal.SizeOf(typeof(FlashInfo)), Handle = h,
                               Flags = 2, Count = 3 }; // FLASHW_TRAY
    FlashWindowEx(ref flash);
    return false;
  }
}
"@

  $parent = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
  $folder = if ($Reveal -and $parent) { $parent.FullName } else { $item.FullName }
  $target = $item.FullName
  $select = $folder -ne $target
  $shell = New-Object -ComObject Shell.Application
  if ($select) {
    [Front]::Reveal($folder, $target)
  } else {
    # A zero-item SHOpenFolderAndSelectItems call selects the supplied folder
    # in its parent. Use the explore verb to navigate into the folder itself.
    Start-Process -FilePath $folder -Verb Explore -ErrorAction Stop
  }
  $wait = [Diagnostics.Stopwatch]::StartNew()
  do {
    $matchedHandle = 0
    $matchedShown = $false
    $foreground = [Front]::VisibleForegroundHandle()
    foreach ($window in $shell.Windows()) {
      # ShellWindows also contains windows/tabs that are still navigating or
      # closing. Only inspect ready filesystem views; retry the rest.
      try {
        $document = $window.Document
        if ($document.Folder.Self.Path -ne $folder) { continue }
        if ($select) {
          $selected = @($document.SelectedItems() | Where-Object { $_.Path -eq $target })
          if (!$selected.Count) { continue }
        }
        $handle = [long]$window.HWND
      } catch { continue }
      if (!$handle) { continue }
      # Multiple views may already match. Keep the one the user can see, and
      # prefer a visible window to a hidden one Explorer kept for reuse.
      if ($handle -eq $foreground) { return }
      if (!$matchedHandle -or (!$matchedShown -and [Front]::Shown($handle))) {
        $matchedHandle = $handle
        $matchedShown = [Front]::Shown($handle)
      }
    }
    if ($matchedHandle) {
      if (![Front]::Raise($matchedHandle)) { [Console]::WriteLine('background') }
      return
    }
    Start-Sleep -Milliseconds 150
  } while ($wait.ElapsedMilliseconds -lt 8000)

  if ($select) { throw 'Explorer did not select the requested item in time.' }
  throw 'Explorer did not show the requested folder in time.'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
