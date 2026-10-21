import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hookScript = fileURLToPath(new URL('./claude-hook.js', import.meta.url))

export const DEFAULT_TITLE = 'Claude Code'
const MAX_COLS = 500
const MAX_ROWS = 200
/** How long after a resize the screen is redrawn (resizes come in bursts while a window is dragged). */
export const REDRAW_DELAY_MS = 250
/** The reasoning levels `claude --effort` takes. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Set by a Claude Code that started this server; a child `claude` would think it is nested. */
export const INHERITED_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT',
]

/**
 * Would make Claude Code bill an API key instead of the Claude subscription it
 * is signed in with. A team never uses the API, so its sessions go without them.
 */
export const API_KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']

/**
 * How long after Claude Code reports its session started its input box takes
 * a pasted message; and, when no hook ever arrives, how long after the start.
 */
export const READY_DELAY_MS = 2500
export const READY_FALLBACK_MS = 15_000

export const isFile = (file) => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Where `claude` is installed: PATH first, then the native and npm installers' folders. */
export function findClaude({ env = process.env, platform = process.platform, home = os.homedir(), exists = isFile } = {}) {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'))
  if (platform === 'win32' && env.APPDATA) dirs.push(join(env.APPDATA, 'npm'))
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir.replace(/^"(.*)"$/, '$1'), name)
      if (exists(file)) return file
    }
  }
  return null
}

/**
 * The program and arguments that start `claude`. An npm install on Windows is
 * a .cmd shim; its script runs under this Node directly, since cmd.exe mangles
 * quoted arguments.
 */
export function launchCommand(claude, args, { platform = process.platform, exists = isFile, node = process.execPath } = {}) {
  if (platform === 'win32' && /\.cmd$/i.test(claude)) {
    const script = path.win32.join(path.win32.dirname(claude), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (exists(script)) return { file: node, args: [script, ...args] }
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', claude, ...args] }
  }
  return { file: claude, args }
}

/**
 * The task name from the title Claude Code gives its terminal ("✳ Fix the
 * login"); '' for its default, and for the program's path Windows sets first.
 */
export function cleanTitle(raw) {
  const text = String(raw ?? '').trim()
  if (/^([a-z]:)?[\\/]/i.test(text) || /\.(exe|cmd)$/i.test(text)) return ''
  const title = text.replace(/^[^\p{L}\p{N}]+/u, '').trim().slice(0, 120)
  return /^(claude|claude code)$/i.test(title) ? '' : title
}

/**
 * The hooks given to every Claude Code this starts (see claude-hook.js), and
 * a constant scroll step per wheel event: Claude Code speeds up a quick run of
 * them, which makes a finger swipe on the phone jump instead of follow.
 */
export function hookSettings(node = process.execPath, script = hookScript) {
  // Claude Code runs hooks with Git Bash on Windows; forward slashes keep the quoting simple.
  const slash = (file) => file.replace(/\\/g, '/')
  const command = { type: 'command', command: `"${slash(node)}" "${slash(script)}"`, timeout: 10, async: true }
  const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'PostModelSwitch']
  return { wheelScrollAccelerationEnabled: false, hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [command] }]])) }
}

/**
 * The settings of a team leader's Claude Code (teams.js). It also reports a
 * turn that ended in an error (StopFailure) and starts in bypass mode without
 * the warning dialog. (A team's children run headless: claude-runner.js.)
 */
export function teamHookSettings(node = process.execPath, script = hookScript) {
  const settings = hookSettings(node, script)
  const slash = (file) => file.replace(/\\/g, '/')
  settings.hooks.StopFailure = [{ hooks: [{ type: 'command', command: `"${slash(node)}" "${slash(script)}"`, timeout: 10, async: true }] }]
  settings.skipDangerousModePermissionPrompt = true
  return settings
}

/**
 * What a hook says about the task: the activity it moves to, its session, and
 * the model and reasoning level Claude Code is using (also after a `/model`).
 */
export function hookEffect(input, activity) {
  const event = input?.hook_event_name
  const effort = EFFORTS.includes(input?.effort?.level) ? input.effort.level : undefined
  const effect = hookActivity(input, event, activity)
  if (effort) effect.effort = effort
  if (event === 'SessionStart' && typeof input.model === 'string') effect.model = input.model
  if (event === 'PostModelSwitch' && typeof input.to_model === 'string') effect.model = input.to_model
  return effect
}

function hookActivity(input, event, activity) {
  if (event === 'SessionStart') {
    // Compaction starts a "session" in the middle of a turn.
    return { session: input.session_id, transcript: input.transcript_path, activity: input.source === 'compact' ? activity : 'idle' }
  }
  if (event === 'UserPromptSubmit') return { activity: 'running', touched: true }
  if (event === 'PostToolUse') return { activity: activity === 'approval' ? 'running' : activity }
  if (event === 'Notification') {
    const type = String(input.notification_type ?? '')
    const waiting = type === 'permission_prompt' || type === 'elicitation_dialog' || (!type && /permission|approval|許可/i.test(String(input.message ?? '')))
    return { activity: waiting ? 'approval' : activity }
  }
  if (event === 'Stop') return { activity: 'idle', touched: true, finished: true }
  // The turn ended on an API error (rate limit, overload): it is not working any more.
  if (event === 'StopFailure') return { activity: 'idle', touched: true, finished: true, failed: true }
  return { activity }
}

const DIALOG_OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/
export const DIALOG_RULE = /^\s*[─━]{12,}\s*$/

/**
 * The choice Claude Code shows (an approval, a question) from the lines on its
 * screen: the last numbered list with one entry picked (❯), and the text above
 * it back to the rule over the dialog. Null when the screen shows none.
 */
export function parseDialog(lines) {
  let last = -1
  for (let i = lines.length - 1; i >= 0 && last < 0; i--) if (DIALOG_OPTION.test(lines[i])) last = i
  if (last < 0) return null
  // Up through the list: entries, the indented lines that go on one (its description),
  // and a rule that sets its last entries apart (a question's "Chat about this").
  const goesOn = (line) => /^\s{4,}\S/.test(line)
  let first = last
  for (let i = last - 1; i >= 0; i--) {
    if (DIALOG_OPTION.test(lines[i])) first = i
    else if (DIALOG_RULE.test(lines[i]) && i > 0 && (DIALOG_OPTION.test(lines[i - 1]) || goesOn(lines[i - 1]))) continue
    else if (!goesOn(lines[i])) break
  }
  const options = []
  for (let i = first; i <= last || (i < lines.length && goesOn(lines[i])); i++) {
    const match = lines[i].match(DIALOG_OPTION)
    if (match) options.push({ key: match[2], label: match[3], detail: '', selected: Boolean(match[1]) })
    else if (!DIALOG_RULE.test(lines[i])) options.at(-1).detail = [options.at(-1).detail, lines[i].trim()].filter(Boolean).join(' ')
  }
  if (!options.some((option) => option.selected) || options.some((option, index) => option.key !== String(index + 1))) return null
  const text = []
  for (let i = first - 1; i >= 0 && !DIALOG_RULE.test(lines[i]) && text.length < 30; i--) {
    const line = lines[i].trim()
    if (line && !/^[╌┄-]+$/.test(line) && !/^Tip:/.test(line)) text.unshift(line)
  }
  return { text, options }
}

export const clampSize = ({ cols, rows } = {}) => ({
  cols: Math.min(MAX_COLS, Math.max(10, Math.floor(Number(cols)) || 100)),
  rows: Math.min(MAX_ROWS, Math.max(4, Math.floor(Number(rows)) || 30)),
})
