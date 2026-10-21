// Windows Firewall for remote access. Windows asks about a program only the
// first time it listens, and only for the network type it was on then: Node.js
// allowed on a "Public" network still gets no connections over Tailscale,
// which Windows treats as "Private" (and it does not ask again). So the app
// checks the rules for its own port and can add one (with an admin prompt).
import { execFile } from 'node:child_process'
import path from 'node:path'

export const RULE_NAME = 'AgentDesk-Remote-Tailscale'
const RULE_TITLE = 'Agent Desk (Tailscale remote access)'

const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`
const encode = (script) => Buffer.from(script, 'utf16le').toString('base64')

/**
 * Inbound rules that decide whether `program` gets TCP connections on `port`
 * from the network `address` is on: the program's own rules and the app's rule.
 */
function rulesScript({ program, port, address }) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$program = ${quote(program)}
$port = '${Number(port)}'
$category = (Get-NetIPAddress -IPAddress ${quote(address)} | Get-NetConnectionProfile).NetworkCategory.ToString()
$profileName = if ($category -eq 'DomainAuthenticated') { 'Domain' } else { $category }
function Test-Applies($rule) {
  if ($rule.Enabled.ToString() -ne 'True' -or $rule.Direction.ToString() -ne 'Inbound') { return $false }
  $profiles = $rule.Profile.ToString()
  if ($profiles -ne 'Any' -and $profiles -notmatch $profileName) { return $false }
  $ports = $rule | Get-NetFirewallPortFilter
  if (@('Any', 'TCP', '6') -notcontains $ports.Protocol.ToString()) { return $false }
  $local = @($ports.LocalPort | ForEach-Object { $_.ToString() })
  return ($local -contains 'Any') -or ($local -contains $port)
}
$rules = @(Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue | Get-NetFirewallRule) +
  @(Get-NetFirewallRule -Name '${RULE_NAME}' -ErrorAction SilentlyContinue)
$rules = @($rules | Where-Object { $_ } | Where-Object { Test-Applies $_ })
`
}

function run(script, timeout) {
  return new Promise((resolve) => {
    execFile(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)], {
      timeout, windowsHide: true,
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }))
  })
}

/**
 * 'allowed', 'blocked' (no rule lets connections in), 'denied' (a rule blocks
 * them), or null when it cannot tell (not Windows, or the check failed).
 */
export async function firewallState({ program = process.execPath, port, address }) {
  if (process.platform !== 'win32' || !address) return null
  const { stdout } = await run(`${rulesScript({ program, port, address })}
$block = @($rules | Where-Object { $_.Action.ToString() -eq 'Block' }).Count
$allow = @($rules | Where-Object { $_.Action.ToString() -eq 'Allow' }).Count
if ($block) { 'denied' } elseif ($allow) { 'allowed' } else { 'blocked' }
`, 20_000)
  const state = stdout.trim().split(/\r?\n/).at(-1)
  return ['allowed', 'blocked', 'denied'].includes(state) ? state : null
}

/** What the elevated PowerShell runs; `whatIf` only reports the changes (tests). */
export function allowScript({ program = process.execPath, port, address, whatIf = false }) {
  const dry = whatIf ? ' -WhatIf' : ''
  return `${rulesScript({ program, port, address })}
$rules | Where-Object { $_.Action.ToString() -eq 'Block' } | Disable-NetFirewallRule${dry}
Remove-NetFirewallRule -Name '${RULE_NAME}' -ErrorAction SilentlyContinue${dry}
New-NetFirewallRule -Name '${RULE_NAME}' -DisplayName ${quote(RULE_TITLE)} -Direction Inbound -Action Allow -Profile Any -Program $program -Protocol TCP -LocalPort $port -RemoteAddress '100.64.0.0/10'${dry} | Out-Null
`
}

/**
 * Adds an inbound rule for this program, this port and Tailscale addresses
 * only, and turns off rules that block it there, in an elevated PowerShell
 * (Windows shows its admin prompt). Resolves to null or an error message.
 */
export async function allowFirewall({ program = process.execPath, port, address }) {
  if (process.platform !== 'win32') return null
  const elevated = allowScript({ program, port, address })
  const { code, stderr } = await run(`
try {
  $process = Start-Process -FilePath ${quote(powershell())} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encode(elevated)}'
  exit $process.ExitCode
} catch {
  exit 1223
}
`, 120_000)
  if (code === 0) return null
  if (code === 1223) return '管理者の確認が取り消されました'
  return `ファイアウォールの設定を変更できませんでした（${stderr.trim().split(/\r?\n/)[0] || `終了コード ${code}`}）`
}
