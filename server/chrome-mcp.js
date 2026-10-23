#!/usr/bin/env node
// The browser tool's MCP server, as dsh launches it for each session.
//
// It relays MCP stdio to Google's chrome-devtools-mcp, pointed at one Chrome
// that Agent Desk shares across sessions: a dedicated profile (so sign-ins
// persist, apart from the user's own Chrome) with remote debugging on
// 127.0.0.1. Chrome starts only when the agent first calls a browser tool, so
// starting a task never opens a window by itself. Several sessions may start
// it at once; Chrome's single-instance lock per profile keeps one browser.
//
// Usage: node chrome-mcp.js --state <file> --profile <dir> --workspace <dir> [--headless]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { findChromium } from './system.js'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}
const stateFile = option('--state')
const profileDir = option('--profile')
const workspace = option('--workspace')
const headless = args.includes('--headless')
if (!stateFile || !profileDir) {
  console.error('chrome-mcp: --state and --profile are required')
  process.exit(2)
}

const log = (...parts) => console.error('[agent-desk chrome]', ...parts)

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return {}
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** The debugging port the shared Chrome uses; chosen once and remembered. */
async function debugPort() {
  const state = readState()
  if (Number.isInteger(state.port)) return state.port
  const port = await freePort()
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, port }))
  return port
}

async function chromeAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

let starting = null

/** Starts the shared Chrome unless it already answers on the debugging port. */
function ensureChrome(port) {
  starting ??= (async () => {
    if (await chromeAnswers(port)) return
    const executable = findChromium({ preferChrome: true })
    if (!executable) throw new Error('Chrome / Edge が見つかりません')
    fs.mkdirSync(profileDir, { recursive: true })
    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      ...(headless ? ['--headless=new'] : []),
      'about:blank',
    ]
    log(`starting ${path.basename(executable)} on port ${port}`)
    let launchError = null
    const child = spawn(executable, chromeArgs, { detached: true, stdio: 'ignore', windowsHide: false })
    // Without a listener, a failed start (the file vanished, say) would end this process.
    child.once('error', (error) => { launchError = error })
    child.unref()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (launchError) throw new Error(`Chrome could not start: ${launchError.message}`)
      if (await chromeAnswers(port)) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`Chrome did not open its debugging port ${port}`)
  })().finally(() => {
    starting = null
  })
  return starting
}

const port = await debugPort()
const mcpBin = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
const mcpArgs = [
  mcpBin,
  `--browserUrl=http://127.0.0.1:${port}`,
  '--usageStatistics=false',
  '--performanceCrux=false',
  '--screenshotFormat=jpeg',
  '--screenshotMaxWidth=1440',
  ...(workspace ? [`--workspace=${workspace}`] : []),
]
const server = spawn(process.execPath, mcpArgs, {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
})
server.on('exit', (code) => process.exit(code ?? 0))

// Forward client messages in order; a tool call first makes sure Chrome runs.
let queue = Promise.resolve()
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  queue = queue.then(async () => {
    if (/"method"\s*:\s*"tools\/call"/.test(line)) {
      try {
        await ensureChrome(port)
      } catch (error) {
        // chrome-devtools-mcp reports the connection failure to the agent.
        log(error.message)
      }
    }
    server.stdin.write(`${line}\n`)
  })
}).on('close', () => {
  void queue.then(() => server.stdin.end())
})
