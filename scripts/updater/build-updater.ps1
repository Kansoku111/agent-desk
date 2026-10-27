# Builds release\AgentDeskUpdater-<version>-<date>.exe: one file a friend runs
# to bring an older install up to this folder's version (see update.ps1).
#   powershell -ExecutionPolicy Bypass -File scripts\updater\build-updater.ps1 [-CopyTo <folder>]
param([string]$CopyTo)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent $here)
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "C# compiler not found: $csc" }

# The UI ships prebuilt, so the friend's PC does not have to build it.
Push-Location -LiteralPath $root
try {
  & cmd.exe /d /c 'npm run build'
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
} finally {
  Pop-Location
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('AgentDeskUpdaterBuild-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$stage = Join-Path $work 'payload'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  foreach ($name in 'assets', 'scripts', 'server', 'shared', 'web', 'AgentDesk.cmd', 'README.md', 'package.json', 'package-lock.json') {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $stage $name) -Recurse -Force
  }
  # Licence and docs: skipped when an older checkout does not have them yet.
  foreach ($name in 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.en.md', 'CHANGELOG.md', 'docs') {
    $source = Join-Path $root $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name) -Recurse -Force }
  }
  # The updater's own sources are not part of the app.
  Remove-Item -LiteralPath (Join-Path $stage 'scripts\updater') -Recurse -Force

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $work 'payload.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)

  $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  # Windows PowerShell 5.1 reads a script without a BOM as ANSI, which breaks the Japanese text.
  $script = Join-Path $work 'update.ps1'
  $text = [IO.File]::ReadAllText((Join-Path $here 'update.ps1'), [Text.Encoding]::UTF8).Replace('__BUILD__', (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  [IO.File]::WriteAllText($script, $text, (New-Object Text.UTF8Encoding $true))

  $release = Join-Path $root 'release'
  New-Item -ItemType Directory -Path $release -Force | Out-Null
  $exe = Join-Path $release "AgentDeskUpdater-$version-$stamp.exe"
  $icon = Get-ChildItem -LiteralPath (Join-Path $root 'assets') -Filter '*.ico' | Select-Object -First 1
  $arguments = @('/nologo', '/target:exe', '/optimize+', '/codepage:65001', "/out:$exe",
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    "/resource:$zip,payload.zip", "/resource:$script,update.ps1")
  if ($icon) { $arguments += "/win32icon:$($icon.FullName)" }
  & $csc @arguments (Join-Path $here 'Stub.cs')
  if ($LASTEXITCODE -ne 0) { throw 'csc failed' }
  Write-Host "built $exe ($([Math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)) MB)"

  if ($CopyTo) {
    Copy-Item -LiteralPath $exe -Destination $CopyTo -Force
    Write-Host "copied to $CopyTo"
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
