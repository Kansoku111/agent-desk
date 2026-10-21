# Shows the Explorer-style "Select Folder" dialog (IFileOpenDialog with
# FOS_PICKFOLDERS) and prints the chosen path as UTF-8; prints nothing when
# cancelled. Falls back to the classic folder browser if the COM dialog fails.
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI, so
# display text arrives through the parameters instead.
param(
  [string]$Title = '',
  [string]$Initial = '',
  [string]$OkLabel = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

$code = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class AgentDeskFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogCoClass {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);

  private const uint FOS_PICKFOLDERS = 0x20;
  private const uint FOS_FORCEFILESYSTEM = 0x40;
  private const uint FOS_PATHMUSTEXIST = 0x800;
  private const uint SIGDN_FILESYSPATH = 0x80058000;
  private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  public static string Pick(IntPtr owner, string title, string initial, string okLabel) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialogCoClass();
    try {
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
      if (!String.IsNullOrEmpty(okLabel)) dialog.SetOkButtonLabel(okLabel);
      if (!String.IsNullOrEmpty(initial) && Directory.Exists(initial)) {
        try {
          Guid iid = typeof(IShellItem).GUID;
          IShellItem folder;
          SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
          dialog.SetFolder(folder);
        } catch (Exception) {}
      }
      int hr = dialog.Show(owner);
      if (hr == ERROR_CANCELLED) return null;
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IShellItem result;
      dialog.GetResult(out result);
      string path;
      result.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      Marshal.ReleaseComObject(dialog);
    }
  }
}

public static class AgentDeskForeground {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint thread, uint to, bool attach);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);

  // Windows refuses the foreground to a background process; sharing input
  // with the window that has it (the app window the user just clicked)
  // lets this one take it.
  public static void Take(IntPtr window) {
    uint current = GetCurrentThreadId();
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
    try {
      BringWindowToTop(window);
      SetForegroundWindow(window);
    } finally {
      if (attached) AttachThreadInput(current, foreground, false);
    }
  }
}
'@

# The dialog opens over its owner: an invisible topmost window in the middle
# of the screen, brought to the foreground first. Without it the dialog opens
# behind the app window (a background process cannot take the foreground) and
# the click seems to do nothing.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner.Location = New-Object System.Drawing.Point(($area.X + [int]($area.Width / 2)), ($area.Y + [int]($area.Height / 3)))
$owner.Show()

try {
  Add-Type -TypeDefinition $code -Language CSharp
  try { [AgentDeskForeground]::Take($owner.Handle) } catch {}
  $picked = [AgentDeskFolderPicker]::Pick($owner.Handle, $Title, $Initial, $OkLabel)
} catch {
  $classic = New-Object System.Windows.Forms.FolderBrowserDialog
  $classic.Description = $Title
  if ($Initial -and (Test-Path -LiteralPath $Initial -PathType Container)) { $classic.SelectedPath = $Initial }
  $picked = if ($classic.ShowDialog($owner) -eq 'OK') { $classic.SelectedPath } else { $null }
}

$owner.Close()
if ($picked) { [Console]::Out.Write($picked) }
