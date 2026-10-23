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
 * Credential/provider environment names retained for compatibility. Team
 * launches inherit these unchanged; claude-auth.js inspects the actual mode
 * and requires explicit per-team consent rather than selecting credentials.
 */
export const API_KEY_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK',
]

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
export function hookSettings(node = process.execPath, script = hookScript, { deniedAgents = [] } = {}) {
  // Claude Code runs hooks with Git Bash on Windows; forward slashes keep the quoting simple.
  const slash = (file) => file.replace(/\\/g, '/')
  const command = { type: 'command', command: `"${slash(node)}" "${slash(script)}"`, timeout: 10, async: true }
  // SubagentStart / SubagentStop: a turn ends (Stop) while its background agents go on working.
  // StopFailure: a turn that ended on an API error (rate limit, overload) runs no Stop.
  const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PostModelSwitch', 'SubagentStart', 'SubagentStop']
  // Lifecycle reports must finish before Claude can advance: an async Start can
  // arrive after Stop and resurrect an agent that has already finished (including
  // a resumed agent, which legitimately reuses its id).
  const ordered = new Set(['SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'Notification'])
  const settings = { wheelScrollAccelerationEnabled: false, hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ ...command, async: !ordered.has(event) }] }]])) }
  if (deniedAgents.length) settings.permissions = { deny: deniedAgents.map((name) => `Agent(${name})`) }
  return settings
}

/** The model an opencodex-generated agent names; only its proxy knows it. */
const PROXY_ROUTED_MODEL = /^claude-ocx-/i

/**
 * The user's agents (`<claudeHome>/agents/*.md`) whose model only a proxy
 * routes, such as opencodex's `ocx-gpt-…`. Without ANTHROPIC_BASE_URL the
 * model never reaches GPT: Claude Code runs the agent on whatever model the
 * call names (often Haiku), while its description promises GPT.
 */
export function unroutedAgents(claudeHome, env = process.env) {
  if (env.ANTHROPIC_BASE_URL) return []
  const dir = path.join(claudeHome, 'agents')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'))
  } catch {
    return []
  }
  const names = []
  for (const file of files) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      continue
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
    const field = (key) => new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+?)["']?\\s*$`, 'm').exec(front)?.[1]
    const name = field('name')
    if (name && PROXY_ROUTED_MODEL.test(field('model') ?? '')) names.push(name)
  }
  return names.sort()
}

/**
 * The settings of a team leader's Claude Code (teams.js). It starts in bypass
 * mode without the warning dialog. (A team's children run headless: claude-runner.js.)
 */
export function teamHookSettings(node = process.execPath, script = hookScript, options = {}) {
  const settings = hookSettings(node, script, options)
  settings.skipDangerousModePermissionPrompt = true
  return settings
}

/**
 * What a hook says about the task: the activity it moves to, its session, and
 * the model and reasoning level Claude Code is using (also after a `/model`).
 * `background`: the work that goes on after the turn ended, which a restart
 * of Claude Code would cut off (see {@link backgroundChange}).
 */
export function hookEffect(input, activity) {
  const event = input?.hook_event_name
  const effort = EFFORTS.includes(input?.effort?.level) ? input.effort.level : undefined
  const effect = hookActivity(input, event, activity)
  if (effort) effect.effort = effort
  if (event === 'SessionStart' && typeof input.model === 'string') effect.model = input.model
  if (event === 'PostModelSwitch' && typeof input.to_model === 'string') effect.model = input.to_model
  const background = backgroundChange(input, event)
  if (background) effect.background = background
  return effect
}

/** Only actual workers with an explicit active status count, not internal hook tasks. */
const BACKGROUND_WORKERS = new Set(['shell', 'monitor', 'workflow', 'teammate', 'cloud session', 'MCP task'])
const TASK_ACTIVE = new Set(['running', 'pending', 'queued', 'in_progress'])

/**
 * Agent lifecycle ids and background task registry ids are different namespaces.
 * Track agents only by their lifecycle; a parent's Stop must not erase them.
 * Stop and SubagentStop carry parent-session registry snapshots on newer CLIs.
 * Older CLIs omit them, which is not evidence that anything has finished.
 * TaskCompleted is a TaskUpdate/task-list event, not background completion.
 */
function backgroundChange(input, event) {
  const id = typeof input?.agent_id === 'string' && input.agent_id ? input.agent_id : null
  const change = {}
  if (event === 'SubagentStart' && id) {
    change.started = id
    change.label = typeof input.agent_type === 'string' ? input.agent_type.slice(0, LABEL_MAX) : ''
  }
  if (event === 'SubagentStop' && id) change.stopped = id
  // Claude documents idle_prompt as suppressed while any background agent runs.
  // This repairs a missed agent completion, without making claims about shells.
  if (event === 'Notification' && input.notification_type === 'idle_prompt' && !id) change.agentsIdle = true
  if (['Stop', 'StopFailure', 'SubagentStop'].includes(event) && Array.isArray(input.background_tasks)) {
    change.running = input.background_tasks
      // Agents have reliable start/stop events; registry ids cannot complete them.
      .filter((task) => task && BACKGROUND_WORKERS.has(task.type) && typeof task.id === 'string' && task.id
        && TASK_ACTIVE.has(String(task.status ?? '').toLowerCase()))
      .map((task) => ({ id: task.id, label: taskLabel(task) }))
  }
  return Object.keys(change).length ? change : null
}

const LABEL_MAX = 300

/** What the user sees for a background task: what it was started for, else what it runs. */
function taskLabel(task) {
  const text = [task.description, task.command, task.name, [task.server, task.tool].filter(Boolean).join(' ')]
    .find((value) => typeof value === 'string' && value.trim())
  return (text ?? task.type).trim().slice(0, LABEL_MAX)
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
