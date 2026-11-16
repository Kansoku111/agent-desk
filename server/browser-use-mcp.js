import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { browserUseEnv } from './browser-use.js'

const run = promisify(execFile)
const actions = ['new_tab', 'navigate', 'list_tabs', 'switch_tab', 'close_tab', 'read_page', 'click', 'fill', 'press', 'scroll', 'back']
export const BROWSER_USE_TOOLS = [
  {
    name: 'browser_action',
    description: 'Operate the local Chrome. Use read_page for page text and controls, and browser_screenshot for viewport coordinates. click accepts a CSS selector or x/y. Tab actions use the id from list_tabs.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: actions },
        url: { type: 'string', description: 'HTTP(S) URL for new_tab or navigate' },
        tab: { type: 'string', description: 'Tab ID for switch_tab or close_tab' },
        selector: { type: 'string', description: 'CSS selector for click or fill' },
        text: { type: 'string', description: 'Text for fill' },
        key: { type: 'string', description: 'Key for press, e.g. Enter or Escape' },
        x: { type: 'number' }, y: { type: 'number' },
        dx: { type: 'number' }, dy: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_screenshot', description: 'Return an image of the current local Chrome page.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { full: { type: 'boolean' } } },
  },
]

const pageSnapshot = `(() => {
  const controls = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[contenteditable=true]'))
    .filter(element => element.getClientRects().length)
    .slice(0, 55)
    .map(element => {
      const id = element.id ? '#' + CSS.escape(element.id) : '';
      const name = element.getAttribute('name');
      const selector = id || (name ? element.localName + '[name=' + CSS.escape(name) + ']' : undefined);
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      return { tag: element.localName, label: (element.getAttribute('aria-label') || element.innerText || element.placeholder || '').trim().slice(0, 120),
        selector, x: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? x : undefined,
        y: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? y : undefined };
    });
  return { title: document.title, url: location.href, text: document.body?.innerText.slice(0, 5500), controls };
})()`
const clickSelector = `(() => {const element = document.querySelector(SELECTOR); if (!element) return null;
  element.scrollIntoView({block:'center',inline:'center'}); const r = element.getBoundingClientRect();
  return [r.x+r.width/2,r.y+r.height/2];})()`

function str(value, field, max = 2048) {
  if (typeof value !== 'string' || value.length > max || (field !== 'text' && !value.trim())) throw new Error(`Invalid ${field}`)
  return value
}

function num(value, field) {
  if (!Number.isFinite(value) || Math.abs(value) > 100_000) throw new Error(`Invalid ${field}`)
  return value
}

function webUrl(value) {
  const parsed = new URL(str(value, 'url'))
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an HTTP(S) URL')
  return parsed.href
}

// Every expression is app-owned. JSON values cross into Python as data even
// when a selector or text contains Python syntax, quotes or line breaks.
function cell(expression, ...values) {
  return `import json\nv = json.loads(${JSON.stringify(JSON.stringify(values))})\n${expression}`
}

export function browserUseCall({ name, arguments: args = {} } = {}) {
  const tool = BROWSER_USE_TOOLS.find(tool => tool.name === name)
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args) ||
    Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new Error('Invalid browser tool arguments')
  if (name === 'browser_screenshot') {
    if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('Invalid full')
    return { name, arguments: { full: args.full ?? false, max_dim: 1440 } }
  }
  let code
  switch (args.action) {
    case 'new_tab': code = cell('print(new_tab(v[0]))', args.url === undefined ? 'about:blank' : webUrl(args.url)); break
    case 'navigate': code = cell('print(goto_url(v[0]))', webUrl(args.url)); break
    case 'list_tabs': code = cell('print(json.dumps(list_tabs(include_chrome=False)))'); break
    case 'switch_tab': code = cell('print(switch_tab(v[0]))', str(args.tab, 'tab')); break
    case 'close_tab': code = cell('print(close_tab(v[0]))', args.tab === undefined ? null : str(args.tab, 'tab')); break
    case 'read_page': code = cell('print(json.dumps(js(v[0]), ensure_ascii=False))', pageSnapshot); break
    case 'click':
      code = args.selector === undefined
        ? cell('click_at_xy(*v); print("Clicked")', num(args.x, 'x'), num(args.y, 'y'))
        : cell('point = js(v[0].replace("SELECTOR", json.dumps(v[1]), 1))\nif point is None: raise ValueError("Element not found")\nclick_at_xy(*point); print("Clicked")',
          clickSelector, str(args.selector, 'selector'))
      break
    case 'fill': code = cell('print(fill_input(*v))', str(args.selector, 'selector'), str(args.text, 'text', 20_000)); break
    case 'press': code = cell('print(press_key(v[0]))', str(args.key, 'key', 64)); break
    case 'scroll': code = cell('print(scroll(v[0], v[1], dx=v[2], dy=v[3]))',
      num(args.x, 'x'), num(args.y, 'y'), num(args.dx ?? 0, 'dx'), num(args.dy ?? 500, 'dy')); break
    case 'back': code = cell('js("history.back()"); print("Back")'); break
    default: throw new Error('Unknown browser action')
  }
  return { name: 'browser_exec', arguments: { code } }
}

export async function runBrowserUseMcp({ command, port, ensureChrome }) {
  let state
  async function upstream() {
    if (state?.client) return state.client
    await ensureChrome(port)
    if (!state) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-bu-'))
      // A unique named CDP daemon gets a dedicated tab on the shared Chrome.
      const env = { ...browserUseEnv(), BU_NAME: path.basename(dir), BU_CDP_URL: `http://127.0.0.1:${port}`, BH_TAB_MARKER: 'off',
        BH_CONFIG_DIR: dir, BH_RUNTIME_DIR: dir, BH_TMP_DIR: dir, BH_AGENT_WORKSPACE: dir, BROWSER_USE_CONFIG_DIR: dir }
      state = { dir, env }
    }
    const client = new Client({ name: 'agent-desk', version: '1' })
    try {
      await client.connect(new StdioClientTransport({ command, args: ['--cli-mcp'], cwd: state.dir, env: state.env, stderr: 'inherit' }), { timeout: 10_000 })
      // Harness closes its own startup tab on daemon shutdown. Open a separate
      // working tab so a settings change leaves the pages the user worked on.
      const initialized = await client.callTool({ name: 'browser_exec', arguments: { code: 'new_tab()' } }, { timeout: 35_000 })
      if (initialized.isError) throw new Error(initialized.content[0]?.text || 'Browser Use could not open a tab')
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }
    state.client = client
    client.onclose = () => { if (state?.client === client) state.client = null }
    return client
  }

  const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const reply = (id, result) => send({ id, result })
  const rpcError = (id, code, message) => send({ id, error: { code, message } })
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()
  input.on('line', line => {
    let request
    try { request = JSON.parse(line) } catch { rpcError(null, -32700, 'Parse error'); return }
    if (!request || typeof request.method !== 'string') { rpcError(request?.id ?? null, -32600, 'Invalid request'); return }
    if (request.id === undefined) return
    const { id, method, params } = request
    if (method === 'initialize') {
      const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
      reply(id, { protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: {} }, serverInfo: { name: 'agent-desk-browser-use', version: '1' } })
    } else if (method === 'ping') reply(id, {})
    else if (method === 'tools/list') reply(id, { tools: BROWSER_USE_TOOLS })
    else if (method === 'tools/call') {
      queue = queue.then(async () => {
        try {
          const call = browserUseCall(params)
          const client = await upstream()
          reply(id, await client.callTool(call, { timeout: 40_000 }))
        } catch (error) {
          reply(id, { content: [{ type: 'text', text: error.message }], isError: true })
        }
      })
    } else rpcError(id, -32601, 'Unknown method')
  })

  await new Promise(resolve => {
    input.once('close', resolve)
    process.once('SIGTERM', () => input.close())
    process.once('SIGINT', () => input.close())
  })
  await queue
  if (state) {
    await state.client?.close().catch(() => {})
    try {
      // Upstream detaches the local daemon from its MCP process. Use the same
      // private name and endpoint files to stop just this session's daemon.
      await run(command, ['--reload'], { cwd: state.dir, env: state.env, timeout: 5000, windowsHide: true })
    } catch (error) {
      console.error('[agent-desk browser use] daemon cleanup:', error.message)
    }
    await fs.rm(state.dir, { recursive: true, force: true, maxRetries: 6 })
      .catch(error => console.error('[agent-desk browser use]', error.message))
  }
}
