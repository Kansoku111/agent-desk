# Start a visible interactive shell even when Agent Desk has no console.
# Keep paths out of command-line parsing (spaces, quotes, brackets and & are literal).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $dir = $env:AGENT_DESK_TERMINAL_DIR
  if (!$dir -or !(Test-Path -LiteralPath $dir -PathType Container)) {
    throw 'The terminal working directory does not exist.'
  }
  $command = 'Set-Location -LiteralPath $env:AGENT_DESK_TERMINAL_DIR'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $shell `
    -ArgumentList @('-NoLogo', '-NoExit', '-EncodedCommand', $encoded) `
    -WorkingDirectory $dir -WindowStyle Normal -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
