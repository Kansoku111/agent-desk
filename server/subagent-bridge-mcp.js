#!/usr/bin/env node
// The subagent tool of a task whose subagents run as another kind of task
// (settings: subagentRoutes), as an MCP server the task's agent starts.
//
// `subagent` hands one prompt to Agent Desk (subagent-bridge.js), which runs it
// as a DSH, Claude Code or Codex child and returns its final answer. The task's
// identity and the route come from Agent Desk, never from this process.
//
// Usage: node subagent-bridge-mcp.js --workspace <dir> --label <who runs it> --note <how it is paid>
// with AGENT_DESK_HOME, AGENT_DESK_SUBAGENT_URL, _PARENT and _TOKEN set.
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { appPaths } from './paths.js'
import { subagentsAllowed } from './subagent-policy-plugin.js'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

/** The tool as the model sees it. */
export function bridgeTool({ workspace, label, note }) {
  return {
    name: 'subagent',
    description: `Run a subagent on ${label || 'the model the user chose'}, the one the user set for this kind of task in Agent Desk${note ? ` (${note})` : ''}. `
      + 'Use it whenever you would delegate work to a subagent. '
      + `It works in ${workspace} with file, shell and web tools, starts with no memory of this conversation, and returns its final answer. `
      + 'Give it everything it needs in the prompt: the goal, the files or commits to look at, and what to report back.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The complete task for the subagent.' } },
      required: ['prompt'],
    },
  }
}

/**
 * Pure protocol handler, so the protocol can be tested apart from the process.
 * `call(prompt, signal)` runs the subagent; `signals` maps request ids to the
 * controllers that cancel them.
 */
export async function handleBridgeMcp(message, { tool, enabled, call, signals = new Map() }) {
  const validObject = message !== null && typeof message === 'object' && !Array.isArray(message)
  const id = validObject ? message.id : undefined
  if (!validObject || typeof message.method !== 'string') return id === undefined ? null : { id, error: { code: -32600, message: 'Invalid Request' } }
  const { method, params } = message
  if (method === 'notifications/cancelled') {
    signals.get(params?.requestId)?.abort()
    return null
  }
  if (id === undefined) return null
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return { id, result: {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-desk-subagent', version: '0.1.0' },
    } }
  }
  if (method === 'ping') return { id, result: {} }
  if (method === 'tools/list') return { id, result: { tools: enabled() ? [tool] : [] } }
  if (method !== 'tools/call') return { id, error: { code: -32601, message: `Method not found: ${method}` } }
  if (params?.name !== tool.name) return { id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } }
  const prompt = typeof params.arguments?.prompt === 'string' ? params.arguments.prompt.trim() : ''
  if (!prompt) return { id, result: { content: [{ type: 'text', text: 'prompt is required' }], isError: true } }
  if (!enabled()) return { id, result: { content: [{ type: 'text', text: 'Subagents are disabled in Agent Desk settings.' }], isError: true } }
  const controller = new AbortController()
  signals.set(id, controller)
  try {
    return { id, result: { content: [{ type: 'text', text: await call(prompt, controller.signal) }] } }
  } catch (error) {
    return { id, result: { content: [{ type: 'text', text: error.message }], isError: true } }
  } finally {
    signals.delete(id)
  }
}

/** One call to Agent Desk: blank lines keep the connection alive, the last line is the answer. */
async function request(prompt, signal) {
  const response = await fetch(process.env.AGENT_DESK_SUBAGENT_URL ?? '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parent: process.env.AGENT_DESK_SUBAGENT_PARENT, token: process.env.AGENT_DESK_SUBAGENT_TOKEN, prompt }),
    signal,
  })
  if (response.status === 403) throw new Error('The subagent is not allowed for this task. Open the task again.')
  const last = (await response.text()).split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  let body = null
  try {
    body = JSON.parse(last)
  } catch {}
  if (!body?.ok) throw new Error(body?.error ?? `Agent Desk HTTP ${response.status}`)
  return String(body.text ?? '')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = appPaths()
  const tool = bridgeTool({ workspace: path.resolve(option('workspace') ?? process.cwd()), label: option('label'), note: option('note') })
  const signals = new Map()
  const pending = new Set()
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const work = handleBridgeMcp(message, { tool, enabled: () => subagentsAllowed(paths.settings), call: request, signals })
      .then((reply) => { if (reply) send(reply) })
      .catch((error) => send({ id: message?.id ?? null, error: { code: -32603, message: error?.message ?? String(error) } }))
      .finally(() => pending.delete(work))
    pending.add(work)
  }).on('close', () => {
    for (const controller of signals.values()) controller.abort()
    void Promise.allSettled([...pending]).then(() => process.exit(0))
  })
}
