#!/usr/bin/env node
// The agent-team MCP server of a team's leader: a Claude Code leader starts it
// from the --mcp-config file teams.js writes, a GPT (dsh) leader's session
// mounts it. Only a team's leader has it, so no other session carries these
// tools. Each call goes to the Agent Desk server, which starts and talks to
// the children (POST /api/team, with the team's secret).
//
// Environment: AGENT_DESK_TEAM_URL, AGENT_DESK_TEAM_ID, AGENT_DESK_TEAM_SECRET;
// AGENT_DESK_TEAM_INSTRUCTIONS names a file of standing instructions given as
// the server's `instructions` (dsh adds them to the system prompt);
// AGENT_DESK_TEAM_PLAYBOOKS adds the `playbook` tool.
import fs from 'node:fs'
import readline from 'node:readline'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const url = process.env.AGENT_DESK_TEAM_URL ?? ''
const teamId = process.env.AGENT_DESK_TEAM_ID ?? ''
const secret = process.env.AGENT_DESK_TEAM_SECRET ?? ''
const CALL_TIMEOUT_MS = 120_000

function readInstructions() {
  const file = process.env.AGENT_DESK_TEAM_INSTRUCTIONS
  if (!file) return ''
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

const child = { type: 'string', description: 'The child\'s name, as `spawn` or `status` gave it.' }

const TOOLS = [
  {
    name: 'spawn',
    description: 'Start a child agent on one part of the work. It runs as its own session in the same folder and reports back to this conversation by itself when it is done (you do not need to check on it). '
      + 'Choose the tier by how demanding the work is and the provider by what suits it; never a model name. Start all the parallel parts at once, then end your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title of the child\'s job, shown to the user (e.g. "生き物 1〜50 のモデル改善").' },
        task: { type: 'string', description: 'The full task, readable on its own: goal, exact scope (which files or items), what done means, where results go, what to report. Put long material in a file and give its path.' },
        tier: { type: 'string', enum: ['low', 'mid'], description: 'low: simple, repetitive or high-volume work. mid: work that needs judgment, design or quality. When the user\'s policy says how to choose a tier, follow it instead.' },
        provider: { type: 'string', enum: ['gpt', 'claude', 'claudeApi', 'deepseek', 'local'], description:'gpt: GPT on the ChatGPT subscription. claude: Claude Code using its own user-confirmed subscription/API/cloud authentication. claudeApi: Claude through dsh on the user\'s Anthropic API key (metered billing; credits depend on their plan). deepseek: DeepSeek on the user\'s DeepSeek API key (billed per token). local: a model on the user\'s own model server (free, weaker; small tasks). Use only the ones `status` lists as available; may be left out when only one is turned on.' },
        name: { type: 'string', description: 'Optional short unique name for the child (e.g. "A" or "効果音"). Default: 子1, 子2, ...' },
        tools: { type: 'boolean', description: 'Only when your instructions say children start without the browser, desktop-control and image-generation tools: true gives this child those tools (a Claude child its MCP servers).' },
      },
      required: ['title', 'task', 'tier'],
    },
  },
  {
    name: 'send',
    description: 'Send a message to a child: fixes after your audit, the next piece of work, or more work on the same scope later. The child keeps its context; a closed or stopped child resumes its conversation. Its report comes back to this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        child,
        message: { type: 'string', description: 'What the child should do now. With `fresh`, the whole task, readable on its own.' },
        fresh: { type: 'boolean', description: 'true: the child starts over in a new conversation (its earlier one is dropped), for work that needs little of it. Not while the child is working.' },
      },
      required: ['child', 'message'],
    },
  },
  {
    name: 'status',
    description: 'List the children (state, model tier, job), the reports waiting for you, and which tiers are available. Reports arrive by themselves, so do not call this in a loop to wait.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_report',
    description: 'Read a child\'s latest report in full (the message that told you about it may be shortened), with its earlier reports that had not reached you yet; those are then not sent to you again.',
    inputSchema: { type: 'object', properties: { child }, required: ['child'] },
  },
  {
    name: 'approve',
    description: 'Answer a child that is stopped waiting for an approval (you were told what it wants to do).',
    inputSchema: {
      type: 'object',
      properties: {
        child,
        allow: { type: 'boolean', description: 'true to allow, false to deny.' },
        message: { type: 'string', description: 'When denying: why, and what the child should do instead.' },
      },
      required: ['child', 'allow'],
    },
  },
  {
    name: 'ask_user',
    description: 'Notify the user that you need their decision (something you cannot decide, or that needs their own judgment, accounts or files). They answer in this conversation; end your turn after asking.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The question, with what the user needs to know to answer it.' },
        child: { type: 'string', description: 'The child it is about, if any.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'close',
    description: 'End a child whose work you accepted (it stops and frees its place). You can still `send` it more work later.',
    inputSchema: { type: 'object', properties: { child }, required: ['child'] },
  },
  // Only when the user has playbooks (AGENT_DESK_TEAM_PLAYBOOKS): otherwise it is not in any turn.
  ...(process.env.AGENT_DESK_TEAM_PLAYBOOKS
    ? [{
      name: 'playbook',
      description: 'Read one of the user\'s playbooks in full (your instructions list them by name).',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The playbook\'s name, as listed.' } }, required: ['name'] },
    }]
    : []),
]

async function call(tool, args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamId, secret, tool, args }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  if (response.status === 403) throw new Error('Agent Desk がこのチームを認めませんでした（チームが削除された可能性があります）')
  const body = await response.json().catch(() => null)
  if (!body) throw new Error(`Agent Desk からの応答を読めませんでした（HTTP ${response.status}）`)
  if (!body.ok) throw new Error(body.error ?? 'Agent Desk でエラーが起きました')
  return String(body.text ?? '')
}

// ------------------------------------------------------------------ MCP over stdio

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  const { id, method, params } = message
  if (id === undefined) return // notifications: initialized, cancelled
  if (message.jsonrpc !== '2.0' || typeof method !== 'string' || !(typeof id === 'string' || Number.isInteger(id))) {
    return send({ id: id ?? null, error: { code: -32600, message: 'Invalid Request' } })
  }
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      return send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-desk-team', version: '0.1.0' },
          ...(readInstructions() ? { instructions: readInstructions() } : {}),
        },
      })
    }
    if (method === 'ping') return send({ id, result: {} })
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } })
    if (method === 'tools/call') {
      const tool = TOOLS.find((entry) => entry.name === params?.name)
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      try {
        return send({ id, result: { content: [{ type: 'text', text: await call(tool.name, params.arguments ?? {}) }] } })
      } catch (error) {
        const reason = error.name === 'TimeoutError' ? 'Agent Desk が時間内に応答しませんでした' : error.message
        return send({ id, result: { content: [{ type: 'text', text: reason }], isError: true } })
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } })
  }
}

const pending = new Set()
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const run = handle(message)
    .catch((error) => send({
      id: message && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null,
      error: { code: -32603, message: error.message },
    }))
    .finally(() => pending.delete(run))
  pending.add(run)
}).on('close', () => {
  // The process ends by itself once the calls in flight are answered: process.exit with a
  // fetch connection still closing trips a libuv assertion on Windows.
  void Promise.allSettled([...pending]).then(() => {
    process.exitCode = 0
    // Should anything still hold it open, it goes anyway.
    setTimeout(() => process.exit(0), 5000).unref()
  })
})
