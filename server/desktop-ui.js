// The desktop tool's UI-element tools (Windows).
//
// desktop-mcp.js acts on screenshot pixels. These tools use the agent-desktop CLI
// (https://github.com/vercel-labs/agent-desktop, Apache-2.0, bundled as the npm
// dependency of the same name) instead: it reads an app's UI elements through
// UI Automation and operates them by name and role, so an action survives window
// moves and DPI scaling and needs no screenshot. Apps that expose little
// accessibility information still need the pixel tools.
//
// The CLI prints one JSON envelope per call ({ ok, data | error }). It is passed
// to the agent as it is: its error `suggestion` and `disposition` (whether a retry
// is safe) are what the agent needs to recover.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

const TIMEOUT_MS = 60_000
// A whole-window snapshot of a browser can run to megabytes; the agent narrows it with skeleton/root/find.
const MAX_OUTPUT_CHARS = 40_000
const BINARY_BY_ARCH = { x64: 'agent-desktop-win32-x64.exe', arm64: 'agent-desktop-win32-arm64.exe' }
const REF = /^@[A-Za-z0-9_-]+:e\d+$/

const ACTIONS = [
  'click', 'double-click', 'triple-click', 'right-click', 'type', 'set-value', 'clear', 'focus',
  'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll-to',
]
/** Actions that also take a value. */
const TEXT_ACTIONS = new Set(['type', 'set-value', 'select'])

// ------------------------------------------------------------------ binary

/**
 * The native executable inside the agent-desktop package. It is run directly, not through the
 * package's Node launcher: that saves a Node start per call, and npm may skip the install
 * script that would link the launcher to the binary.
 */
export function agentDesktopBinary(arch = process.arch, exists = existsSync) {
  const name = BINARY_BY_ARCH[arch]
  if (!name) throw new Error(`agent-desktop は ${arch} の Windows に対応していません`)
  const missing = new Error('agent-desktop が見つかりません。Agent Desk のフォルダで npm install を実行してください')
  let dir
  try {
    dir = path.dirname(require.resolve('agent-desktop/package.json'))
  } catch {
    throw missing
  }
  const file = path.join(dir, 'bin', name)
  if (!exists(file)) throw missing
  return file
}

// ------------------------------------------------------------------ command lines

// String options use `--name=value` and positionals follow `--`, so a value that starts with
// "-" (text to type, a name to search) is never read as another option.
function option(argv, name, value) {
  if (value !== undefined && value !== null && value !== '') argv.push(`--${name}=${value}`)
}

function integer(value, name, min, max) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} は ${min}〜${max} の整数で指定してください`)
  return value
}

function qualifiedRef(ref) {
  if (typeof ref !== 'string' || !REF.test(ref)) {
    throw new Error('ref は ui_snapshot / ui_find が返した "@<snapshot_id>:eN" の形で指定してください（"@e3" のような短縮形は使えません）')
  }
  return ref
}

/** Options that choose the window or region to read; shared by ui_snapshot and ui_find. */
function scope(argv, args) {
  option(argv, 'app', args.app)
  option(argv, 'window-id', args.window_id)
  option(argv, 'surface', args.surface)
  if (args.root !== undefined) option(argv, 'root', qualifiedRef(args.root))
  option(argv, 'timeout-ms', integer(args.timeout_ms, 'timeout_ms', 100, 60_000))
}

export function listArgs(args) {
  if (args.kind !== 'apps' && args.kind !== 'windows') throw new Error('kind は "apps" か "windows" を指定してください')
  // list-windows matches the app name exactly, so a guessed "Calculator" (the window says CalculatorApp.exe)
  // finds nothing and the agent gives up; windows are always listed in full instead.
  const argv = [args.kind === 'apps' ? 'list-apps' : 'list-windows']
  if (args.kind === 'apps') option(argv, 'app', args.app)
  return argv
}

export function snapshotArgs(args) {
  const argv = ['snapshot']
  scope(argv, args)
  // Interactive elements only and compact are the defaults: a full tree is mostly text nobody can act on.
  if (args.interactive_only !== false) argv.push('--interactive-only')
  if (args.compact !== false) argv.push('--compact')
  if (args.skeleton) argv.push('--skeleton')
  option(argv, 'max-depth', integer(args.max_depth, 'max_depth', 1, 30))
  return argv
}

export function findArgs(args) {
  const argv = ['find']
  scope(argv, args)
  for (const key of ['role', 'name', 'text', 'value']) option(argv, key, args[key])
  if (args.exact) argv.push('--exact')
  // The CLI returns up to 50 matches; a smaller default keeps the answer short.
  option(argv, 'limit', integer(args.limit ?? 20, 'limit', 1, 200))
  return argv
}

export function actArgs(args) {
  if (!ACTIONS.includes(args.action)) throw new Error(`action は ${ACTIONS.join(', ')} のいずれかを指定してください`)
  const ref = qualifiedRef(args.ref)
  const argv = [args.action]
  if (args.headed) argv.push('--headed')
  if (args.action === 'scroll') {
    option(argv, 'direction', args.direction)
    option(argv, 'amount', integer(args.amount, 'amount', 1, 100))
  }
  argv.push('--', ref)
  if (TEXT_ACTIONS.has(args.action)) {
    if (typeof args.text !== 'string') throw new Error(`${args.action} には text を指定してください`)
    argv.push(args.text)
  }
  return argv
}

// ------------------------------------------------------------------ running the CLI

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（出力が長いため ${MAX_OUTPUT_CHARS} 文字で切り詰めました。skeleton や root、ui_find で範囲を絞ってください）`
}

function failureText(error, stderr) {
  if (error.killed) return 'agent-desktop が時間内に終わりませんでした'
  // Windows refuses to start the unsigned binary (Smart App Control, antivirus) before it can print anything.
  if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'UNKNOWN') {
    return 'agent-desktop を起動できませんでした。Smart App Control やウイルス対策ソフトが実行をブロックしている可能性があります（署名のない実行ファイルです）'
  }
  return String(stderr || error.message).trim()
}

/** Runs the CLI once. Resolves with the envelope text and whether the CLI reported ok. */
export function runAgentDesktop(argv, { binary, execFileImpl = execFile, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(binary(), argv, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env }, (error, stdout, stderr) => {
      const out = String(stdout ?? '').trim()
      // A failed action exits non-zero but still prints its envelope; only a missing one is a crash.
      if (!out) return error ? reject(new Error(failureText(error, stderr))) : resolve({ ok: true, text: '' })
      let ok = false
      try {
        ok = JSON.parse(out).ok === true
      } catch {
        // Not an envelope (older or broken build): show it as it is.
      }
      resolve({ ok, text: clip(out) })
    })
  })
}

// ------------------------------------------------------------------ tools

const target = {
  app: { type: 'string', description: 'App name as ui_list shows it, e.g. "Notepad.exe". Store apps are listed as ApplicationFrameHost.exe in kind=apps; use the app_name of their window from kind=windows (e.g. "CalculatorApp.exe"). Not needed for a shell surface such as the taskbar.' },
  window_id: { type: 'string', description: 'Window id from ui_list kind=windows (e.g. "w-4521"), when the app has several windows.' },
  surface: {
    type: 'string',
    enum: ['window', 'focused', 'sheet', 'menu', 'taskbar', 'system-tray', 'system-tray-overflow', 'start-menu', 'action-center'],
    description: 'What to read instead of the app window: an open menu, a dialog (sheet), or a shell surface such as the taskbar. Default window.',
  },
  root: { type: 'string', description: 'Read only inside this element ("@<snapshot_id>:eN") instead of the whole window.' },
  timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, description: 'Read deadline (default 3000-5000). Raise it for browsers and Electron apps, which read thin until they settle.' },
}

/** The MCP tools; `run` resolves to MCP content or throws (reported to the agent as a tool error). */
export function createUiTools({ binary = agentDesktopBinary, execFileImpl = execFile, env = process.env } = {}) {
  const exec = async (argv) => {
    const { ok, text } = await runAgentDesktop(argv, { binary, execFileImpl, env })
    if (!ok) throw new Error(text || 'agent-desktop の操作に失敗しました')
    return [{ type: 'text', text }]
  }
  return [
    {
      name: 'ui_list',
      description: 'List running apps or open windows (with their ids and app_name) to find the app name for ui_snapshot / ui_find. Start here. Use kind=windows for Store apps.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['apps', 'windows'] },
          app: { type: 'string', description: 'A fragment of the app name, to narrow kind=apps. kind=windows always lists every window.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: (args) => exec(listArgs(args)),
    },
    {
      name: 'ui_snapshot',
      description: 'Read an app\'s UI elements as JSON. Elements you can act on carry a ref ("@<snapshot_id>:eN") for ui_act. '
        + 'No pixels and no mouse movement; works on windows behind others but not minimized ones (restore them first). '
        + 'Large apps: take a skeleton first, then read one region with root. Refs belong to their snapshot; take a new one after the UI changes.',
      inputSchema: {
        type: 'object',
        properties: {
          ...target,
          skeleton: { type: 'boolean', description: 'Shallow map with children_count on cut branches, to find the region to read.' },
          interactive_only: { type: 'boolean', description: 'Only elements you can act on (default true).' },
          compact: { type: 'boolean', description: 'Collapse single-child unnamed nodes (default true).' },
          max_depth: { type: 'integer', minimum: 1, maximum: 30, description: 'Tree depth (default 10).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: (args) => exec(snapshotArgs(args)),
    },
    {
      name: 'ui_find',
      description: 'Search an app\'s UI elements by role, name, text or value and get their refs. Cheaper than a snapshot when you know what you are looking for (role e.g. button, textfield, checkbox).',
      inputSchema: {
        type: 'object',
        properties: {
          ...target,
          role: { type: 'string' },
          name: { type: 'string', description: 'Accessible name or label.' },
          text: { type: 'string', description: 'Text in the name, value, title or description.' },
          value: { type: 'string', description: 'Current value.' },
          exact: { type: 'boolean', description: 'Case-insensitive exact match for name and value instead of a substring.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most matches to return (default 20).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      run: (args) => exec(findArgs(args)),
    },
    {
      name: 'ui_act',
      description: 'Operate one element by ref from ui_snapshot / ui_find, through UI Automation (no mouse movement, no focus change). Returns the delivery result, not the new screen: '
        + 'check it with ui_snapshot / ui_find / screenshot. If disposition.retry is not "safe" the action may have landed, so read the state before repeating it. '
        + 'On Windows, type, right-click, double-click, triple-click and focus work only with headed=true (they move the real cursor or take the focus); prefer set-value to type text. '
        + 'The other actions work without it.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          ref: { type: 'string', description: '"@<snapshot_id>:eN" from ui_snapshot / ui_find.' },
          text: { type: 'string', description: 'The text for type, the value for set-value, the option to choose for select.' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'For scroll (default down).' },
          amount: { type: 'integer', minimum: 1, maximum: 100, description: 'Scroll units for scroll (default 3).' },
          headed: { type: 'boolean', description: 'Allow physical input: moves the real cursor or takes the focus. Only for the actions that need it, when the user is not using the PC.' },
        },
        required: ['action', 'ref'],
        additionalProperties: false,
      },
      run: (args) => exec(actArgs(args)),
    },
  ]
}
