# Agent Desk updater: replaces an existing install's app files with the
# version packed into AgentDeskUpdater.exe (see build-updater.ps1).
# Runs on the stock Windows PowerShell 5.1. The data folder
# (%APPDATA%\AgentDesk) is never touched.
#
#   -Payload     folder holding the new version's files (the exe passes it)
#   -InstallDir  update this install without looking for one
#   -ListOnly    only show the install found and the running instance
#   -NoLaunch    do not start Agent Desk afterwards
#   -NoPause     do not wait for Enter before closing
param(
  [Parameter(Mandatory = $true)][string]$Payload,
  [string]$InstallDir,
  [switch]$ListOnly,
  [switch]$NoLaunch,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$Build = '__BUILD__'
# The app's own folders, replaced as a whole; top-level files are overwritten.
# Anything else in the install folder (node_modules, the user's own files) stays.
$ManagedDirs = @('assets', 'scripts', 'server', 'web', 'shared', 'docs')
$ManagedFiles = @('AgentDesk.cmd', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.en.md', 'CHANGELOG.md', 'package.json', 'package-lock.json')
$DshPackages = @('@deepseek-ai/dsh', '@deepseek-ai/dsh-atomic-write')

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step([string]$text) { Write-Host ''; Write-Host "▶ $text" -ForegroundColor Cyan }

function Finish([int]$code) {
  if (-not $NoPause) {
    Write-Host ''
    Read-Host 'Enter キーで閉じます' | Out-Null
  }
  exit $code
}

function Fail([string]$text) {
  Write-Host ''
  Say "✖ $text" 'Red'
  Finish 1
}

function Confirm([string]$question) {
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes|はい)$')
}

function DataHome {
  if ($env:AGENT_DESK_HOME) { return [IO.Path]::GetFullPath($env:AGENT_DESK_HOME) }
  return Join-Path $env:APPDATA 'AgentDesk'
}

function ReadJson([string]$file) {
  try { return [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return $null }
}

# ------------------------------------------------------------------ versions

# Compares two semver strings (1.2.3, 1.2.3-rc.2); returns -1, 0 or 1.
function CompareVersion([string]$a, [string]$b) {
  $pa = $a.Split('-', 2); $pb = $b.Split('-', 2)
  $na = $pa[0].Split('.'); $nb = $pb[0].Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $x = [int]$na[$i]; $y = [int]$nb[$i]
    if ($x -ne $y) { if ($x -lt $y) { return -1 } else { return 1 } }
  }
  # A release is newer than any of its prereleases.
  if ($pa.Count -eq 1 -and $pb.Count -eq 1) { return 0 }
  if ($pa.Count -eq 1) { return 1 }
  if ($pb.Count -eq 1) { return -1 }
  $ia = $pa[1].Split('.'); $ib = $pb[1].Split('.')
  for ($i = 0; $i -lt [Math]::Min($ia.Count, $ib.Count); $i++) {
    $x = $ia[$i]; $y = $ib[$i]
    if ($x -eq $y) { continue }
    $xn = $x -match '^\d+$'; $yn = $y -match '^\d+$'
    if ($xn -and $yn) { if ([int]$x -lt [int]$y) { return -1 } else { return 1 } }
    if ($xn) { return -1 }
    if ($yn) { return 1 }
    if ([string]::CompareOrdinal($x, $y) -lt 0) { return -1 } else { return 1 }
  }
  if ($ia.Count -eq $ib.Count) { return 0 }
  if ($ia.Count -lt $ib.Count) { return -1 } else { return 1 }
}

function DshVersion([string]$packageJson) {
  $package = ReadJson $packageJson
  if (-not $package -or -not $package.dependencies) { return $null }
  $version = $package.dependencies.'@deepseek-ai/dsh'
  if ($version -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { return $version }
  return $null
}

# ------------------------------------------------------------------ finding the install

function IsInstall([string]$dir) {
  if (-not $dir) { return $false }
  $package = ReadJson (Join-Path $dir 'package.json')
  return ($package -and $package.name -eq 'agent-desk' -and (Test-Path -LiteralPath (Join-Path $dir 'server\index.js')))
}

# Folders named in a command line or shortcut: the paths themselves and their parents.
function PathsIn([string]$text) {
  $found = @()
  if (-not $text) { return $found }
  foreach ($m in [regex]::Matches($text, '[A-Za-z]:\\[^"*?<>|]+')) {
    $p = $m.Value.Trim()
    # An unquoted path ends at the next argument.
    $p = ($p -split '\s+(?=-|[A-Za-z]:\\)')[0].Trim()
    for ($i = 0; $i -lt 4 -and $p; $i++) {
      $found += $p
      $p = Split-Path -Parent $p
    }
  }
  return $found
}

function FromRunningInstance {
  $info = ReadJson (Join-Path (DataHome) 'server.json')
  if (-not $info -or -not $info.pid) { return @() }
  $found = @()
  $id = [int]$info.pid
  # The server (node <root>\server\index.js), or the console that started it (AgentDesk.cmd).
  for ($depth = 0; $depth -lt 5 -and $id; $depth++) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (-not $process) { break }
    $found += PathsIn $process.CommandLine
    $id = [int]$process.ParentProcessId
  }
  return $found
}

function FromShortcuts {
  $places = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Desk.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Desk.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Agent Desk.lnk')
  )
  $shell = New-Object -ComObject WScript.Shell
  $found = @()
  foreach ($file in $places) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $link = $shell.CreateShortcut($file)
    $found += PathsIn "$($link.TargetPath) $($link.Arguments) $($link.WorkingDirectory)"
  }
  return $found
}

# Looks for package.json files of Agent Desk a few levels under the usual places.
function FromFolders {
  $roots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('MyDocuments'),
    (Join-Path $env:USERPROFILE 'Downloads'),
    $env:USERPROFILE
  )
  if ($env:OneDrive) { $roots += $env:OneDrive }
  foreach ($drive in [IO.DriveInfo]::GetDrives()) {
    if ($drive.DriveType -eq 'Fixed' -and $drive.IsReady) { $roots += $drive.RootDirectory.FullName }
  }
  $skip = @('node_modules', '.git', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData', '$Recycle.Bin', 'System Volume Information')
  $found = @()
  $seen = @{}
  foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
    $level = @($root)
    for ($depth = 0; $depth -le 3 -and $level.Count -gt 0; $depth++) {
      $next = @()
      foreach ($dir in $level) {
        if ($seen.ContainsKey($dir)) { continue }
        $seen[$dir] = $true
        if (Test-Path -LiteralPath (Join-Path $dir 'package.json')) { $found += $dir }
        try {
          $next += Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $skip -notcontains $_.Name -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
            ForEach-Object { $_.FullName }
        } catch {}
      }
      $level = $next
    }
  }
  return $found
}

function Installs([string[]]$paths) {
  $result = @()
  foreach ($p in $paths) {
    try { $full = [IO.Path]::GetFullPath($p).TrimEnd('\') } catch { continue }
    if ($result -contains $full) { continue }
    if (IsInstall $full) { $result += $full }
  }
  return $result
}

function PickFolder {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Agent Desk のフォルダ（AgentDesk.cmd がある場所）を選んでください'
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $dialog.SelectedPath
}

function ChooseInstall {
  $installs = Installs ((FromRunningInstance) + (FromShortcuts))
  if ($installs.Count -eq 0) {
    Say '  起動中のアプリとショートカットからは見つからないので、フォルダを探しています…'
    $installs = Installs (FromFolders)
  }
  if ($installs.Count -eq 1) {
    Say "  見つかりました: $($installs[0])" 'White'
    if ($ListOnly -or (Confirm '  このフォルダを更新しますか？')) { return $installs[0] }
  } elseif ($installs.Count -gt 1) {
    Say '  Agent Desk のフォルダが複数見つかりました。' 'White'
    for ($i = 0; $i -lt $installs.Count; $i++) { Say "    $($i + 1). $($installs[$i])" 'White' }
    if ($ListOnly) { return $installs[0] }
    $answer = Read-Host '  更新するフォルダの番号を入力してください（0 で自分で選ぶ）'
    $n = 0
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $installs.Count) { return $installs[$n - 1] }
  } else {
    Say '  自動では見つかりませんでした。' 'Yellow'
  }
  if ($ListOnly) { return $null }
  $picked = PickFolder
  if (-not $picked) { return $null }
  if (-not (IsInstall $picked)) {
    # The zip may have been extracted with an extra AgentDesk folder inside.
    $inner = Join-Path $picked 'AgentDesk'
    if (IsInstall $inner) { return $inner }
    Fail "選んだフォルダは Agent Desk ではありません（package.json と server フォルダがありません）: $picked"
  }
  return $picked
}

# ------------------------------------------------------------------ the running instance

function Ping([int]$port) {
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/ping" -TimeoutSec 3
    if ($status.app -eq 'agent-desk') { return $status }
  } catch {}
  return $null
}

function NodeProcessesIn([string]$root) {
  $pattern = [regex]::Escape($root.TrimEnd('\') + '\')
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
}

# Stops the running Agent Desk once no task is running. Returns $false when the user cancels.
function StopRunning([string]$root) {
  $info = ReadJson (Join-Path (DataHome) 'server.json')
  $status = $null
  if ($info -and $info.port) { $status = Ping ([int]$info.port) }
  if ($status) {
    if ($status.busy) {
      Say '  作業中のタスクがあります。終わるまで待ってから止めます（Ctrl+C で中止）。' 'Yellow'
      while ($status -and $status.busy) {
        Start-Sleep -Seconds 5
        $status = Ping ([int]$info.port)
      }
    }
    while ($status) {
      try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$($info.port)/api/quit?t=$($info.token)" -Method Post -TimeoutSec 5 -UseBasicParsing | Out-Null
      } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 409) {
          # A task started just now.
          Say '  作業が始まったので、終わるまで待ちます…' 'Yellow'
          Start-Sleep -Seconds 5
          $status = Ping ([int]$info.port)
          continue
        }
        Say "  アプリに終了を頼めませんでした（$($_.Exception.Message)）。" 'Yellow'
        if (-not (Confirm '  Agent Desk を強制終了して続けますか？')) { return $false }
        & taskkill.exe /PID $info.pid /T /F | Out-Null
      }
      break
    }
    # Shutting down stops the engines and terminals first; give it time.
    for ($i = 0; $i -lt 60; $i++) {
      if (-not (Get-Process -Id ([int]$info.pid) -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Seconds 1
    }
    Say '  Agent Desk を終了しました。'
  }
  # Anything still running from this folder would lock its files (node-pty, dsh).
  $left = NodeProcessesIn $root
  if ($left.Count -gt 0) {
    Start-Sleep -Seconds 3
    $left = NodeProcessesIn $root
  }
  if ($left.Count -gt 0) {
    Say "  このフォルダのプログラムがまだ $($left.Count) 個動いています。" 'Yellow'
    if (-not (Confirm '  終了させて続けますか？')) { return $false }
    foreach ($p in $left) { & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }
    Start-Sleep -Seconds 2
  }
  return $true
}

# ------------------------------------------------------------------ files

function RunNpm([string]$root, [string[]]$arguments) {
  Push-Location -LiteralPath $root
  try {
    # Shown as it runs; kept out of this function's return value.
    # stderr is merged inside cmd: PowerShell would stop at npm's first warning line.
    & cmd.exe /d /c "npm $($arguments -join ' ') 2>&1" | Out-Host
    return $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

function CopyItems([string]$from, [string]$to) {
  foreach ($name in $ManagedDirs) {
    $source = Join-Path $from $name
    # An older payload may not carry every folder; keep the target's copy then.
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $target = Join-Path $to $name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  }
  foreach ($name in $ManagedFiles) {
    $source = Join-Path $from $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $to $name) -Force }
  }
}

# Puts the backup back. If that fails too, say where the backup is and stop here.
function RestoreBackup([string]$backup, [string]$root) {
  try {
    CopyItems $backup $root
  } catch {
    Fail "元に戻せませんでした（$($_.Exception.Message)）。バックアップは $backup にあります。Agent Desk を閉じてから、もう一度実行してください。"
  }
}

# ------------------------------------------------------------------ main

$newPackage = ReadJson (Join-Path $Payload 'package.json')
if (-not $newPackage) { Fail '更新データが壊れています（package.json を読めません）。' }

Write-Host ''
Say '  Agent Desk アップデーター' 'White'
Say "  新しい版: $($newPackage.version)（$Build 版）"
Say '  設定・API キー・タスクの履歴（%APPDATA%\AgentDesk）はそのまま残ります。'

Step 'Node.js を確認しています'
$nodeVersion = $null
try { $nodeVersion = (& cmd.exe /d /c "node.exe -v 2>nul") } catch {}
if (-not $nodeVersion) {
  Fail 'Node.js が見つかりません。https://nodejs.org/ から LTS 版を入れてから、もう一度実行してください。'
}
$v = $nodeVersion.TrimStart('v')
if ((CompareVersion $v '22.19.0') -lt 0 -or ((CompareVersion $v '23.0.0') -ge 0 -and (CompareVersion $v '24.0.0') -lt 0)) {
  Fail "Node.js $nodeVersion は古いので使えません（22.19 以上か 24 以上が必要です）。https://nodejs.org/ から LTS 版を入れてください。"
}
Say "  Node.js $nodeVersion"

Step 'Agent Desk のフォルダを探しています'
if ($InstallDir) {
  $root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  if (-not (IsInstall $root)) { Fail "Agent Desk のフォルダではありません: $root" }
  Say "  $root" 'White'
} else {
  $root = ChooseInstall
  if (-not $root) { Fail 'フォルダが選ばれなかったので、何も変更せずに終了します。' }
}

$oldPackage = ReadJson (Join-Path $root 'package.json')
# The app's version number rarely changes; the updater stamps each install it makes.
$buildFile = Join-Path $root 'updater-build.txt'
$oldBuild = '配布時の版'
if (Test-Path -LiteralPath $buildFile) { $oldBuild = (Get-Content -LiteralPath $buildFile -Raw).Trim() }
Say "  今の版: $($oldPackage.version)（$oldBuild）"

if ($ListOnly) {
  $info = ReadJson (Join-Path (DataHome) 'server.json')
  $status = $null
  if ($info -and $info.port) { $status = Ping ([int]$info.port) }
  if ($status) { Say "  起動中: ポート $($info.port)・作業中=$($status.busy)" } else { Say '  起動していません' }
  Finish 0
}

Step '起動中の Agent Desk を終了しています'
if (-not (StopRunning $root)) { Fail '中止しました。何も変更していません。' }

Step '今のファイルをバックアップしています'
$backup = Join-Path (DataHome) 'app-update-backup'
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
New-Item -ItemType Directory -Path $backup -Force | Out-Null
CopyItems $root $backup
Set-Content -LiteralPath (Join-Path $backup 'FROM.txt') -Value $root -Encoding UTF8
Say "  $backup"

Step '新しい版のファイルに入れ替えています'
$oldDsh = DshVersion (Join-Path $root 'package.json')
$newDsh = DshVersion (Join-Path $Payload 'package.json')
try {
  CopyItems $Payload $root
} catch {
  Say "  入れ替えに失敗しました: $($_.Exception.Message)" 'Red'
  Say '  元に戻しています…'
  RestoreBackup $backup $root
  Fail '更新できませんでした。元の版に戻しました。Agent Desk を閉じてから、もう一度実行してください。'
}

Step '必要なパッケージを入れています（数分かかることがあります）'
# dsh may have been updated from inside the app; never take it back to an older release.
if ($oldDsh -and $newDsh -and (CompareVersion $oldDsh $newDsh) -gt 0) {
  Say "  dsh はアプリ内で更新済みの $oldDsh を使い続けます。"
  $packages = $DshPackages | ForEach-Object { "$_@$oldDsh" }
  $code = RunNpm $root (@('install', '--save-exact', '--no-audit', '--no-fund') + $packages)
} else {
  $code = RunNpm $root @('install', '--no-audit', '--no-fund')
}
if ($code -ne 0) {
  Say '  npm install に失敗しました。元の版に戻しています…' 'Red'
  RestoreBackup $backup $root
  RunNpm $root @('install', '--no-audit', '--no-fund') | Out-Null
  Fail 'インターネットにつながっているか確かめて、もう一度実行してください。元の版に戻しました。'
}

Set-Content -LiteralPath $buildFile -Value $Build -Encoding UTF8
Write-Host ''
Say "✔ 更新しました（$oldBuild → $Build）。" 'Green'

if (-not $NoLaunch) {
  Step 'Agent Desk を起動しています'
  $vbs = Join-Path $root 'scripts\launch.vbs'
  $node = (Get-Command node.exe).Source
  Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$vbs`"", "`"$node`"") -WorkingDirectory $root
  Say '  新しいウィンドウが開きます。前の版のウィンドウが残っていたら閉じてください。'
}
Finish 0
