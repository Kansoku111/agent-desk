#!/usr/bin/env node
// The GPT subagent of a Claude Code task, as an MCP server Claude Code starts.
//
// `subagent_gpt` hands one task to a headless dsh on the GPT model the user
// chose for subagents (settings: subagentModels), on the ChatGPT
// subscription, and returns its answer. The model comes from the layer
// index.js writes (dsh-config.js gptSubagentPatch), read at each call.
//
// Usage: node gpt-subagent-mcp.js --workspace <dir> [--name <model label>]
// with AGENT_DESK_HOME set to the app home.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { runtimeHookArgs } from './dsh-compatibility.js'
import { appPaths, dshBin } from './paths.js'
import { dshEnv } from './dsh-env.js'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const STDERR_TAIL = 4000

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

const paths = appPaths()
const workspace = path.resolve(option('workspace') ?? process.cwd())
const label = option('name') || 'GPT'

const TOOL = {
  name: 'subagent_gpt',
  description: `Run a subagent on ${label}, the GPT model the user chose for subagents in Agent Desk (covered by their ChatGPT subscription). `
    + 'Use it whenever the user asks for a GPT subagent, GPT\'s review or a second opinion from GPT; no other agent runs on GPT. '
    + `It works in ${workspace} with file, shell and web tools, starts with no memory of this conversation, and returns its final answer. `
    + 'Give it everything it needs in the prompt: the goal, the files or commits to look at, and what to report back.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The complete task for the subagent.' },
    },
    required: ['prompt'],
  },
}

/** Running subagents by MCP request id, so a cancelled call stops its dsh. */
const running = new Map()

function run(id, prompt) {
  if (!fs.existsSync(paths.gptSubagentPatch)) {
    return Promise.reject(new Error('No GPT subagent model is set. Choose one in Agent Desk\'s model settings.'))
  }
  return new Promise((resolve, reject) => {
    const layers = [paths.homePatch, paths.gptSubagentPatch].filter((file) => fs.existsSync(file)).flatMap((file) => ['--patch', file])
    const child = spawn(process.execPath, [...runtimeHookArgs(), dshBin, '--profile', 'headless', ...layers, '-'], {
      cwd: workspace,
      // As the user's own tasks run; Claude Code's approval of the call is the gate.
      env: dshEnv(paths, 'danger-full-access'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    running.set(id, child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL) })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      running.delete(id)
      if (code === 0) resolve(stdout.trim() || '(the subagent returned no text)')
      else reject(new Error(signal ? `The subagent was stopped (${signal}).` : `The subagent failed (exit ${code}).\n${stderr.trim()}`))
    })
    child.stdin.end(prompt)
  })
}

// ------------------------------------------------------------------ MCP over stdio

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function handle(message) {
  const { id, method, params } = message
  if (method === 'notifications/cancelled') return running.get(params?.requestId)?.kill()
  if (id === undefined) return
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      return send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-desk-gpt', version: '0.1.0' },
        },
      })
    }
    if (method === 'ping') return send({ id, result: {} })
    if (method === 'tools/list') return send({ id, result: { tools: [TOOL] } })
    if (method === 'tools/call') {
      if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      const prompt = typeof params.arguments?.prompt === 'string' ? params.arguments.prompt.trim() : ''
      if (!prompt) return send({ id, result: { content: [{ type: 'text', text: 'prompt is required' }], isError: true } })
      try {
        return send({ id, result: { content: [{ type: 'text', text: await run(id, prompt) }] } })
      } catch (error) {
        return send({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } })
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } })
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  void handle(message)
}).on('close', () => {
  for (const child of running.values()) child.kill()
  process.exit(0)
})
