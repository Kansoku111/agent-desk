import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import YAML from 'yaml'
import { gptSubagentPatch, homePatch } from '../server/dsh-config.js'

test('the GPT subagent\'s layer runs the chosen GPT model, without subagent tools or their guidance', () => {
  const subagents = [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }]
  const persona = { personaPrefix: 'You are a coding agent.', personaSuffix: 'Your working directory is {{cwd}}.' }
  const rows = YAML.parse(gptSubagentPatch({ subagents, persona }))
  assert.deepEqual(rows[0], { id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } })
  const added = YAML.parse(homePatch({ subagents, persona })).flatMap((row) => row.insert ?? []).map((row) => row.id)
  for (const id of ['tool-subagent', 'tool-subagent-fork', ...added.filter((entry) => entry.startsWith('agent-desk-subagent-'))]) {
    assert.ok(rows.some((row) => row.id === id && row.disabled), id)
  }
  assert.deepEqual(rows.find((row) => row.id === 'system-prompt'), { id: 'system-prompt', config: persona })
})

test('configured reasoning reaches both pinned tools and the Claude Code GPT layer', () => {
  const subagents = [
    { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    { provider: 'openai-codex', model: 'gpt-6.1-sol', effort: 'high' },
  ]
  const tools = YAML.parse(homePatch({ subagents })).flatMap(row => row.insert ?? []).filter(row => row.config?.toolName?.startsWith('subagent_'))
  assert.deepEqual(tools.map(row => row.config.agentOptions.reasoningEffort), ['low', 'high'])
  assert.deepEqual(YAML.parse(gptSubagentPatch({ subagents }))[0].config, {
    provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high',
  })
})

test('no GPT subagent model, no layer', () => {
  assert.equal(gptSubagentPatch({ subagents: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }] }), null)
  assert.equal(gptSubagentPatch(), null)
})

test('disabled MCP returns no tool definitions and rejects a stale invocation even with a model layer', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-disabled-mcp-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ subagentsEnabled: false }))
  await fs.writeFile(path.join(dir, 'gpt-subagent.patch.yml'), gptSubagentPatch({ subagents: [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }] }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/gpt-subagent-mcp.js', import.meta.url))], {
    env: { ...process.env, AGENT_DESK_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stdin.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n')
  assert.deepEqual(JSON.parse((await lines.next()).value).result.tools, [])
  child.stdin.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'subagent_gpt', arguments: { prompt: 'must not start' } } }) + '\n')
  const reply = JSON.parse((await lines.next()).value)
  assert.equal(reply.result.isError, true)
  assert.match(reply.result.content[0].text, /disabled/)
  child.stdin.end()
  assert.equal((await closed)[0], 0)
})

test('MCP ignores non-object inputs and returns Invalid Request for malformed requests with an id', async t => {
  const script = fileURLToPath(new URL('../server/gpt-subagent-mcp.js', import.meta.url))
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, AGENT_DESK_HOME: path.join(os.tmpdir(), 'agent-desk-invalid-mcp-test') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = '', stderr = ''
  const responses = []
  let resolveResponses, rejectResponses
  const received = new Promise((resolve, reject) => {
    resolveResponses = resolve
    rejectResponses = reject
  })
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line) responses.push(JSON.parse(line))
      if (responses.length === 2) resolveResponses(responses)
    }
  })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', rejectResponses)
  const closed = once(child, 'close')
  const timeout = setTimeout(() => rejectResponses(new Error(`MCP replies timed out: ${stderr}`)), 5000)
  try {
    child.stdin.write([
      'null',
      '[]',
      '42',
      JSON.stringify({ id: 'invalid' }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ].join('\n') + '\n')
    const replies = await received
    child.stdin.end()
    const [code] = await closed
    assert.equal(code, 0, stderr)
    assert.deepEqual(replies[0], { jsonrpc: '2.0', id: 'invalid', error: { code: -32600, message: 'Invalid Request' } })
    assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 1, result: {} })
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await closed
    }
  }
})
