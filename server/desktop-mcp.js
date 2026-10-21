#!/usr/bin/env node
// The desktop tool's MCP server (Windows), as dsh launches it for each session.
//
// It lets the agent see the screen and drive the mouse and keyboard, like a
// person at the PC. The Windows calls run in desktop-helper.ps1, which starts
// on the first tool call and stays up for the session. Screenshots are scaled
// to fit 1280x800; every coordinate the agent sends is a pixel of the latest
// screenshot of the current display, mapped back to physical pixels here.
//
// Usage: node desktop-mcp.js
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { displayFor, parseKeys, toScreen, toView, viewFor } from './desktop.js'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const helperScript = fileURLToPath(new URL('./desktop-helper.ps1', import.meta.url))
const log = (...parts) => console.error('[agent-desk desktop]', ...parts)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ helper

let helper = null

/** The running PowerShell helper, started on first use and again if it died. */
export function startHelper(spawnImpl = spawn) {
  if (helper) return helper
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pending = new Map()
  let nextId = 1
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const fail = (error) => {
    readyReject(error)
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
    if (helper?.child === child) helper = null
  }
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log('helper:', line)
      return
    }
    if (message.ready) return readyResolve()
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error || 'デスクトップ操作に失敗しました'))
  })
  child.stderr.on('data', (chunk) => log(String(chunk).trim()))
  child.on('error', (error) => fail(error))
  child.on('exit', (code) => fail(new Error(`デスクトップ操作の補助プロセスが終了しました（${code}）`)))
  helper = {
    child,
    ready,
    call(cmd, args = {}) {
      const id = nextId++
      // Escape non-ASCII so the text survives any console code page.
      const line = JSON.stringify({ id, cmd, ...args }).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`デスクトップ操作が時間内に終わりませんでした（${cmd}）`))
        }, 60_000)
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        })
        child.stdin.write(`${line}\n`)
      })
    },
  }
  return helper
}

async function call(cmd, args) {
  const current = startHelper()
  await current.ready
  return current.call(cmd, args)
}

// ------------------------------------------------------------------ screen state

/** Which display the agent is looking at; its screenshots define the coordinates. */
let currentDisplay = 0

async function displays() {
  const { items } = await call('displays')
  return items.map((d) => ({ index: d.Index, name: d.Name, primary: d.Primary, x: d.X, y: d.Y, width: d.Width, height: d.Height }))
}

async function activeDisplay() {
  const list = await displays()
  return list[currentDisplay] ?? list[0]
}

async function screenshot(display) {
  const view = viewFor(display)
  const { data } = await call('capture', {
    x: display.x, y: display.y, width: display.width, height: display.height,
    outWidth: view.width, outHeight: view.height, cursor: true, quality: 70,
  })
  return { type: 'image', data, mimeType: 'image/jpeg' }
}

function displayLine(display, list) {
  const view = viewFor(display)
  const others = list.length > 1 ? ` Other displays: ${list.filter((d) => d !== display).map((d) => `${d.index}`).join(', ')} (switch with screenshot { display }).` : ''
  return `Display ${display.index}${display.primary ? ' (primary)' : ''}: screenshot is ${view.width}x${view.height} px `
    + `(screen ${display.width}x${display.height}). Use pixel coordinates of this image for actions.${others}`
}

/** An action's result: a short note plus, unless turned off, a fresh screenshot. */
async function afterAction(note, args, display) {
  if (args.screenshot === false) return [{ type: 'text', text: note }]
  await sleep(Math.min(5000, Math.max(0, Number(args.settle_ms ?? 500))))
  return [{ type: 'text', text: note }, await screenshot(display)]
}

// ------------------------------------------------------------------ keys

/** Virtual-key codes for parsed combos; layout-dependent characters ask the helper. */
async function resolveCombo(combo) {
  const keys = []
  for (const key of combo) {
    if (typeof key === 'number') {
      keys.push(key)
      continue
    }
    const { vk, shift } = await call('keyForChar', { char: key })
    if (shift && !keys.includes(0x10)) keys.push(0x10)
    keys.push(vk)
  }
  return keys
}

// ------------------------------------------------------------------ tools

const point = {
  x: { type: 'integer', description: 'X in pixels of the latest screenshot.' },
  y: { type: 'integer', description: 'Y in pixels of the latest screenshot.' },
}
const screenshotOption = {
  screenshot: { type: 'boolean', description: 'Return a screenshot after the action (default true). Set false when chaining quick actions.' },
  settle_ms: { type: 'integer', description: 'Wait this long before the screenshot so the screen can update (default 500, max 5000).' },
}

const TOOLS = [
  {
    name: 'screenshot',
    description: 'Take a screenshot of the user\'s Windows desktop (the mouse cursor is drawn in). Start here: every other action uses pixel coordinates of the latest screenshot. Pass display to switch monitors.',
    inputSchema: {
      type: 'object',
      properties: { display: { type: 'integer', description: 'Display index (0 = primary). Stays selected for later actions.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const list = await displays()
      if (args.display !== undefined) {
        if (!list[args.display]) throw new Error(`ディスプレイ ${args.display} はありません（0〜${list.length - 1}）`)
        currentDisplay = args.display
      }
      const display = list[currentDisplay] ?? list[0]
      return [{ type: 'text', text: displayLine(display, list) }, await screenshot(display)]
    },
  },
  {
    name: 'zoom',
    description: 'Look at part of the screen at full resolution, to read small text. Coordinates stay those of the full screenshot; zooming does not change them.',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const display = await activeDisplay()
      const view = viewFor(display)
      const clampX = (v) => Math.min(view.width - 1, Math.max(0, v))
      const clampY = (v) => Math.min(view.height - 1, Math.max(0, v))
      const a = toScreen(display, clampX(Math.min(args.x1, args.x2)), clampY(Math.min(args.y1, args.y2)))
      const b = toScreen(display, clampX(Math.max(args.x1, args.x2)), clampY(Math.max(args.y1, args.y2)))
      const width = Math.max(1, b.x - a.x)
      const height = Math.max(1, b.y - a.y)
      const out = viewFor({ width, height })
      const { data } = await call('capture', { x: a.x, y: a.y, width, height, outWidth: out.width, outHeight: out.height, cursor: false, quality: 80 })
      return [
        { type: 'text', text: `Zoomed region (${args.x1},${args.y1})-(${args.x2},${args.y2}) shown at ${out.width}x${out.height}.` },
        { type: 'image', data, mimeType: 'image/jpeg' },
      ]
    },
  },
  {
    name: 'click',
    description: 'Click at a point of the latest screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        ...point,
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, description: '2 for a double click, 3 for a triple click. Default 1.' },
        hold_keys: { type: 'string', description: 'Modifier keys held during the click, e.g. "ctrl" or "ctrl+shift".' },
        ...screenshotOption,
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async run(args) {
      const display = await activeDisplay()
      const target = toScreen(display, args.x, args.y)
      const hold = args.hold_keys ? await resolveCombo(parseKeys(args.hold_keys)[0]) : []
      const button = args.button ?? 'left'
      const clicks = Math.min(3, Math.max(1, args.clicks ?? 1))
      await call('click', { x: target.x, y: target.y, button, count: clicks, hold })
      const kind = clicks === 2 ? 'Double-clicked' : clicks === 3 ? 'Triple-clicked' : 'Clicked'
      return afterAction(`${kind} ${button} at (${args.x}, ${args.y}).`, args, display)
    },
  },
  {
    name: 'move_mouse',
    description: 'Move the mouse pointer (hover) to a point of the latest screenshot.',
    inputSchema: { type: 'object', properties: { ...point, ...screenshotOption }, required: ['x', 'y'], additionalProperties: false },
    async run(args) {
      const display = await activeDisplay()
      const target = toScreen(display, args.x, args.y)
      await call('move', target)
      return afterAction(`Moved the mouse to (${args.x}, ${args.y}).`, args, display)
    },
  },
  {
    name: 'drag',
    description: 'Press a mouse button at one point, move to another and release (drag and drop, selecting, resizing).',
    inputSchema: {
      type: 'object',
      properties: {
        start_x: { type: 'integer' }, start_y: { type: 'integer' }, end_x: { type: 'integer' }, end_y: { type: 'integer' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
        ...screenshotOption,
      },
      required: ['start_x', 'start_y', 'end_x', 'end_y'],
      additionalProperties: false,
    },
    async run(args) {
      const display = await activeDisplay()
      const from = toScreen(display, args.start_x, args.start_y)
      const to = toScreen(display, args.end_x, args.end_y)
      await call('drag', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, button: args.button ?? 'left' })
      return afterAction(`Dragged from (${args.start_x}, ${args.start_y}) to (${args.end_x}, ${args.end_y}).`, args, display)
    },
  },
  {
    name: 'scroll',
    description: 'Scroll with the mouse wheel over a point of the latest screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        ...point,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 30, description: 'Wheel notches (default 3; one notch is about 3 lines).' },
        ...screenshotOption,
      },
      required: ['x', 'y', 'direction'],
      additionalProperties: false,
    },
    async run(args) {
      const display = await activeDisplay()
      const target = toScreen(display, args.x, args.y)
      const amount = Math.min(30, Math.max(1, args.amount ?? 3))
      const dx = args.direction === 'right' ? amount : args.direction === 'left' ? -amount : 0
      const dy = args.direction === 'down' ? amount : args.direction === 'up' ? -amount : 0
      await call('scroll', { ...target, dx, dy })
      return afterAction(`Scrolled ${args.direction} ${amount} at (${args.x}, ${args.y}).`, args, display)
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the focused window as keyboard input (any language; "\\n" presses Enter). Click the field first. Japanese text is sent as-is, so it does not go through IME conversion.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...screenshotOption }, required: ['text'], additionalProperties: false },
    async run(args) {
      const display = await activeDisplay()
      const text = String(args.text ?? '')
      if (!text) throw new Error('text を指定してください')
      await call('type', { text })
      return afterAction(`Typed ${[...text].length} characters.`, args, display)
    },
  },
  {
    name: 'press_keys',
    description: 'Press a key or shortcut, e.g. "enter", "ctrl+s", "alt+tab", "win+r", "ctrl+shift+esc". Separate several with spaces to press them in order: "ctrl+a ctrl+c".',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string' },
        repeat: { type: 'integer', minimum: 1, maximum: 50, description: 'Press the whole sequence this many times (default 1).' },
        ...screenshotOption,
      },
      required: ['keys'],
      additionalProperties: false,
    },
    async run(args) {
      const display = await activeDisplay()
      const combos = []
      for (const combo of parseKeys(args.keys)) combos.push(await resolveCombo(combo))
      const repeat = Math.min(50, Math.max(1, args.repeat ?? 1))
      for (let i = 0; i < repeat; i++) {
        for (const keys of combos) {
          await call('keys', { keys })
          await sleep(30)
        }
      }
      return afterAction(`Pressed ${args.keys}${repeat > 1 ? ` x${repeat}` : ''}.`, args, display)
    },
  },
  {
    name: 'list_windows',
    description: 'List open windows (front to back) with their handle, app and position in screenshot pixels of the display they are on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run() {
      const list = await displays()
      const { items } = await call('windows')
      const lines = items.map((w) => {
        const flags = [w.Focused && 'focused', w.Minimized && 'minimized'].filter(Boolean).join(', ')
        let where = ''
        if (!w.Minimized) {
          const display = displayFor(list, { x: w.X, y: w.Y, width: w.Width, height: w.Height })
          const a = toView(display, w.X, w.Y)
          const b = toView(display, w.X + w.Width, w.Y + w.Height)
          where = ` display ${display.index} at (${a.x}, ${a.y}) ${b.x - a.x}x${b.y - a.y}`
        }
        return `handle=${w.Handle} [${w.Process}] "${w.Title}"${flags ? ` (${flags})` : ''}${where}`
      })
      return [{ type: 'text', text: lines.length ? lines.join('\n') : 'No windows.' }]
    },
  },
  {
    name: 'focus_window',
    description: 'Bring a window to the front (restoring it if minimized), by handle from list_windows or by part of its title.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'integer' },
        title: { type: 'string', description: 'Case-insensitive part of the window title; the front-most match wins.' },
        ...screenshotOption,
      },
      additionalProperties: false,
    },
    async run(args) {
      let handle = args.handle
      let label = `handle=${handle}`
      if (handle === undefined) {
        const query = String(args.title ?? '').toLowerCase()
        if (!query) throw new Error('handle か title を指定してください')
        const { items } = await call('windows')
        const match = items.find((w) => w.Title.toLowerCase() === query) ?? items.find((w) => w.Title.toLowerCase().includes(query))
        if (!match) throw new Error(`タイトルに "${args.title}" を含むウィンドウはありません`)
        handle = match.Handle
        label = `"${match.Title}"`
      }
      const { focused } = await call('focus', { handle })
      // Follow the window to its display so the next coordinates fit.
      const list = await displays()
      const { items } = await call('windows')
      const window = items.find((w) => w.Handle === handle)
      if (window && !window.Minimized) currentDisplay = displayFor(list, { x: window.X, y: window.Y, width: window.Width, height: window.Height }).index
      const display = list[currentDisplay] ?? list[0]
      const note = focused ? `Focused ${label}.` : `Asked Windows to focus ${label}, but another window kept the focus.`
      return afterAction(note, args, display)
    },
  },
  {
    name: 'wait',
    description: 'Wait for the screen to change (an app starting, a page loading), then take a screenshot.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', minimum: 0.1, maximum: 30, description: 'Default 1.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args) {
      const seconds = Math.min(30, Math.max(0.1, Number(args.seconds ?? 1)))
      await sleep(seconds * 1000)
      const list = await displays()
      const display = list[currentDisplay] ?? list[0]
      return [{ type: 'text', text: `Waited ${seconds}s. ${displayLine(display, list)}` }, await screenshot(display)]
    },
  },
]

const INSTRUCTIONS = 'Controls the user\'s real Windows desktop with mouse and keyboard. Take a screenshot first and after anything '
  + 'that changes the screen; coordinates are pixels of the latest screenshot. Prefer shell or file tools when they can do the job, '
  + 'and use this for apps that have no other interface. The user may be using the PC at the same time: do only what the task needs, '
  + 'and ask before anything irreversible (sending, purchasing, deleting, changing system settings).'

// ------------------------------------------------------------------ MCP over stdio

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return // notifications: initialized, cancelled
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      return send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-desk-desktop', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        },
      })
    }
    if (method === 'ping') return send({ id, result: {} })
    if (method === 'tools/list') {
      return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) } })
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((candidate) => candidate.name === params?.name)
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      try {
        const content = await tool.run(params.arguments ?? {})
        return send({ id, result: { content } })
      } catch (error) {
        return send({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } })
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } })
  }
}

function serve() {
  if (process.platform !== 'win32') {
    log('the desktop tool works on Windows only')
    process.exit(1)
  }

  // One request at a time: the screen is one shared thing.
  let queue = Promise.resolve()
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    queue = queue.then(() => handle(message))
  }).on('close', () => {
    void queue.then(() => {
      helper?.child.stdin.end()
      process.exit(0)
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve()
