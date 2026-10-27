import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import YAML from 'yaml'
import { abPatch, homePatch } from '../server/dsh-config.js'
import { abToolAllowed, apply } from '../server/ab-policy-plugin.js'
import { AbRunner, abClaudeArgs } from '../server/ab-runner.js'
import { AB_CONSULT } from '../server/ab.js'
import { runtimeKey } from '../server/runtime.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { fixture, deferred, pending } from './helpers/thread-manager.js'

test('AB runtime has no write/shell/delegation definitions during consultation', () => {
  for (const lean of [true, false]) {
    const rows = YAML.parse(abPatch({ lean, subagents: [{ provider: 'anthropic', model: 'test' }, { provider: 'openai-codex', model: 'test' }] }))
    const disabled = (id) => rows.some((row) => row.id === id && row.disabled)
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-workflow', 'tool-goal', 'tool-subagent', 'tool-subagent-fork', 'tool-plugin-manager', 'tool-ask-user']) assert.ok(disabled(id), id)
    assert.deepEqual(rows.find((row) => row.id === 'tool-fs').config, { write: false, edit: false })
    assert.equal(disabled('tool-web'), lean)
  }
  const write = YAML.parse(abPatch({ writable: true }))
  assert.ok(!write.some((row) => row.id === 'tool-fs'))
  assert.ok(!write.some((row) => row.id === 'tool-pwsh'))
})

test('AB guard fails closed for unknown tools and rejects sandbox escalation', () => {
  for (const name of ['run_code', 'read', 'glob', 'grep', 'web_search', 'web_fetch']) assert.equal(abToolAllowed(name, false), true)
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'subagent', 'workflow', 'unknown_new_tool', 'mcp__chrome__evaluate_script']) assert.equal(abToolAllowed(name, false), false)
  let guard
  apply({ tools: { guard: (fn) => { guard = fn } }, systemPrompt: { section: () => {} } }, { writable: false })
  assert.ok(guard({ name: 'read', arguments: { sandbox_permissions: 'danger-full-access' } }))
  assert.equal(guard({ name: 'read', arguments: {} }), undefined)
  assert.equal(guard({ name: 'run_code', arguments: { code: 'return 42' } }), undefined)
  assert.ok(guard({ name: 'run_code', arguments: { sandbox_permissions: 'danger-full-access' } }))
  for (const name of ['subagent', 'workflow', 'create_goal', 'unknown_new_tool']) assert.ok(guard({ name, arguments: {} }))
  apply({ tools: { guard: (fn) => { guard = fn } }, systemPrompt: { section: () => {} } }, { writable: true })
  assert.equal(guard({ name: 'run_code', arguments: {} }), undefined)
  assert.ok(guard({ name: 'run_code', arguments: { sandbox_permissions: 'workspace-write' } }))
  assert.ok(guard({ name: 'subagent', arguments: {} }))
})

test('AB tells every role its standing permissions and how to avoid escalation', () => {
  for (const writable of [false, true]) {
    const sections = []
    apply({ tools: { guard() {} }, systemPrompt: { section: (section) => sections.push(section) } }, { writable })
    const text = sections[0].text
    assert.match(text, writable ? /danger-full-access/ : /read-only/)
    assert.match(text, /Approval prompts are unavailable in AB/)
    assert.match(text, /Omit sandbox_permissions and justification/)
    assert.match(text, /run_code.*nested.*native/)
    assert.match(text, /do not retry escalation/)
  }
})

test('AB removes inherited fixed-model delegation guidance without losing the base persona', () => {
  const subagents = [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }]
  const persona = { personaPrefix: 'Coding persona', personaSuffix: 'Workspace: {{cwd}}' }
  const home = YAML.parse(homePatch({ subagents, persona }))
  assert.match(home.find((row) => row.id === 'system-prompt').config.personaSuffix, /Subagents on a fixed model/)
  for (const writable of [false, true]) for (const lean of [false, true]) {
    const rows = YAML.parse(abPatch({ subagents, persona, writable, lean }))
    assert.deepEqual(rows.find((row) => row.id === 'system-prompt'), { id: 'system-prompt', config: persona })
    for (const id of ['agent-desk-subagent-claude', 'agent-desk-subagent-gpt']) assert.ok(rows.some((row) => row.id === id && row.disabled))
  }
})

test('AB uses separate profiles and no mutating MCP in consultation even with tools ON', () => {
  assert.equal(runtimeKey({ ab: { lean: true }, permissionMode: 'read-only' }), 'ab:lean')
  assert.equal(runtimeKey({ ab: { lean: false }, permissionMode: 'read-only' }), 'ab:research')
  assert.equal(runtimeKey({ ab: { writable: true }, permissionMode: 'workspace-write' }), 'ab:write')
  const getServers = createMcpServerList({ paths: {}, getSettings: () => ({ browserTool: true, desktopTool: true, imageTool: true }), getTeams: () => null })
  assert.deepEqual(getServers({ ab: { writable: false, lean: false } }), [])
})

test('Claude consultation is an allowlist with no inherited MCP or browser', () => {
  const lean = abClaudeArgs({ writable: false, lean: true, instructions: 'consult' })
  const full = abClaudeArgs({ writable: false, lean: false, instructions: 'consult' })
  assert.equal(lean[lean.indexOf('--tools') + 1], 'Read,Glob,Grep')
  assert.equal(full[full.indexOf('--tools') + 1], 'Read,Glob,Grep,WebSearch,WebFetch')
  assert.ok(full.includes('--strict-mcp-config'))
  assert.ok(full.includes('--no-chrome'))
  assert.ok(!abClaudeArgs({ writable: true }).includes('--tools'))
})

test('AB pricing updates follow the pending completion notification', async () => {
  const threads = new EventEmitter(), agents = new EventEmitter(), gate = deferred()
  threads.get = async () => { await gate.promise; return { thread: { score: { points: 0, priced: 0, unpriced: 1 } }, turns: [] } }
  const runner = new AbRunner({ threads, agents })
  runner.owned.set('T', { runId: 'R', jobId: 'J', writable: false, denials: [] })
  const events = []
  runner.on('finished', () => events.push('finished'))
  const scored = new Promise((resolve) => runner.on('score', (value) => { events.push('score'); resolve(value) }))
  threads.emit('turn-finished', { threadId: 'T', status: 'done' })
  threads.emit('usage-priced', { id: 'T', ab: { runId: 'R', jobId: 'J' }, score: { points: 3, priced: 1, unpriced: 0 } })
  assert.deepEqual(events, [])
  gate.resolve()
  assert.deepEqual(await scored, { runId: 'R', jobId: 'J', threadId: 'T', score: { points: 3, priced: 1, unpriced: 0 } })
  assert.deepEqual(events, ['finished', 'score'])
})

test('AB adapter sends raw consultation and translates final results', async () => {
  const threads = new EventEmitter()
  const agents = new EventEmitter()
  let created, sent
  threads.create = async (value) => { created = value; return { id: 'T' } }
  threads.send = async (_id, value) => { sent = value }
  threads.get = async () => ({ turns: [{ items: [{ type: 'agent', text: 'final report' }] }] })
  const runner = new AbRunner({ threads, agents })
  await runner.start({ runId: 'R', jobId: 'J', model: '["openai-codex","test"]', workspace: '/project', writable: false, lean: true, toolMode: 'ptc', instructions: AB_CONSULT, text: ' raw\nrequest ' })
  assert.equal(sent.text, ' raw\nrequest ')
  assert.equal(created.permissionMode, 'read-only')
  assert.equal(created.toolMode, 'ptc')
  assert.equal(created.ab.runId, 'R')
  const finished = new Promise((resolve) => runner.once('finished', resolve))
  threads.emit('turn-finished', { threadId: 'T', status: 'done' })
  assert.deepEqual(await finished, { runId: 'R', jobId: 'J', status: 'completed', text: 'final report', error: undefined, denials: [] })
})
