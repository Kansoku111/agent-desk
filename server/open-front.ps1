param(
  [string]$Path = $env:AGENT_DESK_FILE_PATH,
  [switch]$Reveal
)
# Wait for the requested Explorer location, including reused windows/tabs, and
# report failure to the caller instead of raising unrelated new windows.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
  $item = Get-Item -LiteralPath $Path -Force
  if (!$Reveal -and !$item.PSIsContainer) {
    # ShellExecute uses the file association and reports launch errors. Do not
    # route files through explorer.exe, which hides failures from the caller.
    Start-Process -FilePath $item.FullName -ErrorAction Stop
    return
  }

  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Front {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attrs, out uint found);
  [DllImport("shell32.dll")]
  static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, IntPtr[] items, uint flags);
  [DllImport("shell32.dll")] static extern IntPtr ILFindLastID(IntPtr pidl);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static void Reveal(string folder, string target) {
    IntPtr folderId = IntPtr.Zero, targetId = IntPtr.Zero;
    uint attrs;
    try {
      Marshal.ThrowExceptionForHR(SHParseDisplayName(folder, IntPtr.Zero, out folderId, 0, out attrs));
      IntPtr[] selection = null;
      if (!String.Equals(folder, target, StringComparison.OrdinalIgnoreCase)) {
        Marshal.ThrowExceptionForHR(SHParseDisplayName(target, IntPtr.Zero, out targetId, 0, out attrs));
        selection = new[] { ILFindLastID(targetId) };
      }
      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(folderId, selection == null ? 0u : 1u, selection, 0));
    } finally {
      if (targetId != IntPtr.Zero) Marshal.FreeCoTaskMem(targetId);
      if (folderId != IntPtr.Zero) Marshal.FreeCoTaskMem(folderId);
    }
  }

  public static bool Raise(long handle) {
    var h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    // Windows restricts background activation. Try the same short Alt gesture
    // as before, only when needed, and verify the actual foreground handle.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
}
"@

  $parent = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
  $folder = if ($Reveal -and $parent) { $parent.FullName } else { $item.FullName }
  $target = $item.FullName
  $select = $folder -ne $target
  $shell = New-Object -ComObject Shell.Application
  [Front]::Reveal($folder, $target)
  $matched = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
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
      $matched = $true
      if ([Front]::Raise($handle)) { return }
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($matched) { throw 'Explorer opened the location, but Windows did not allow it to come to the foreground.' }
  throw 'Explorer did not show the requested location and selection in time.'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
