# Creates the "Agent Desk" Start menu shortcut (and its icon) that starts the
# app through scripts\launch.vbs, so it always runs the code in this folder.
# Pin it to the taskbar from the Start menu: right-click > Pin to taskbar.
#
# The shortcut carries the AppUserModelID of the app window (Edge --app with
# Agent Desk's own profile), so the running window groups under the pinned
# icon instead of appearing as a separate Edge button.
param(
  [string]$AppUserModelId = 'MSEdge.127.0.0.1_/.browserprole.Default',
  [switch]$Desktop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# ------------------------------------------------------------------ icon
function New-AgentDeskIcon {
  Add-Type -AssemblyName System.Drawing
  $sizes = 16, 24, 32, 48, 64, 128, 256
  $frames = foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 64.0
    # Rounded square, as in web/public/favicon.svg.
    $r = 16 * $s
    $box = New-Object System.Drawing.Drawing2D.GraphicsPath
    $box.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $box.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $box.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $box.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $box.CloseFigure()
    # Muted rainbow from the top-left to the bottom-right corner.
    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::White), ([System.Drawing.Color]::White), 45.0, $true
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend 6
    $blend.Colors = [System.Drawing.Color[]]@('#DCA3A3', '#E3BC98', '#DCD0A0', '#A9C9A9', '#A4BFD0', '#BDB0D3' | ForEach-Object { [System.Drawing.ColorTranslator]::FromHtml($_) })
    $blend.Positions = [single[]]@(0, 0.2, 0.4, 0.6, 0.8, 1)
    $fill.InterpolationColors = $blend
    $g.FillPath($fill, $box)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#2E3142')), ([Math]::Max(1.5, 5 * $s))
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $g.DrawLines($pen, [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF (18 * $s), (22 * $s)),
      (New-Object System.Drawing.PointF (28 * $s), (32 * $s)),
      (New-Object System.Drawing.PointF (18 * $s), (42 * $s))))
    $g.DrawLine($pen, (33 * $s), (43 * $s), (46 * $s), (43 * $s))
    $g.Dispose()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    ,@($size, $stream.ToArray())
  }
  # ICO container holding PNG frames.
  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $out
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($frame in $frames) {
    $size = $frame[0]; $data = $frame[1]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$data.Length); $w.Write([UInt32]$offset)
    $offset += $data.Length
  }
  foreach ($frame in $frames) { $w.Write([byte[]]$frame[1]) }
  $w.Flush()
  ,$out.ToArray()
}

# Windows caches shortcut icons by file path, so a redrawn icon under the old
# name keeps showing the old picture. The name carries a hash of the image
# instead: a new design gets a new path, and older icons are removed.
$iconBytes = New-AgentDeskIcon
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = [System.BitConverter]::ToString($sha.ComputeHash($iconBytes)).Replace('-', '').Substring(0, 8).ToLower()
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force $assets | Out-Null
$icon = Join-Path $assets "agent-desk-$hash.ico"
if (-not (Test-Path $icon)) { [System.IO.File]::WriteAllBytes($icon, $iconBytes) }

# ------------------------------------------------------------------ shortcut
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $root 'scripts\launch.vbs'
$arguments = '"' + $launcher + '"'
if ($node) { $arguments += ' "' + $node + '"' }

$targets = @(Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Desk.lnk')
if ($Desktop) { $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Desk.lnk' }
# A taskbar pin is a copy of the shortcut taken when it was pinned; refresh it too.
$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Agent Desk.lnk'
if (Test-Path $pinned) { $targets += $pinned }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentDeskShortcut {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PROPERTYKEY key);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    void Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr context, int flags, ref Guid iid, out IPropertyStore store);

  public static void SetAppUserModelId(string shortcut, string id) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(shortcut, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);
    PROPERTYKEY key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PROPVARIANT value = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, pointer = Marshal.StringToCoTaskMemUni(id) };
    try {
      store.SetValue(ref key, ref value);
      store.Commit();
    } finally {
      Marshal.FreeCoTaskMem(value.pointer);
      Marshal.ReleaseComObject(store);
    }
  }
}
'@

$shell = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $wscript
  $link.Arguments = $arguments
  $link.WorkingDirectory = $root
  $link.IconLocation = "$icon,0"
  $link.Description = 'Agent Desk'
  $link.Save()
  [AgentDeskShortcut]::SetAppUserModelId($path, $AppUserModelId)
  Write-Output "shortcut: $path"
}

# Older icons go once no shortcut points at them, and Explorer redraws.
Get-ChildItem $assets -Filter 'agent-desk*.ico' | Where-Object { $_.FullName -ne $icon } | Remove-Item -Force -ErrorAction SilentlyContinue
$ie4uinit = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path $ie4uinit) { & $ie4uinit -show }
