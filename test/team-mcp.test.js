import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../server/team-mcp.js', import.meta.url))

/** A stand-in for Agent Desk's POST /api/team. */
async function fakeDesk(answer) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const call = JSON.parse(body)
    calls.push(call)
    const [status, reply] = answer(call)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { calls, url: `http://127.0.0.1:${server.address().port}/api/team`, close: () => server.close() }
}

function startMcp(url, env = {}) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, AGENT_DESK_TEAM_URL: url, AGENT_DESK_TEAM_ID: 'team-1', AGENT_DESK_TEAM_SECRET: 's3cret', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map()
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  let id = 0
  const request = (method, params) => new Promise((resolve) => {
    id += 1
    waiting.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const raw = (message) => new Promise((resolve) => {
    const requestId = message && typeof message === 'object' && !Array.isArray(message) ? message.id : undefined
    if (requestId !== undefined) waiting.set(requestId, resolve)
    child.stdin.write(`${JSON.stringify(message)}\n`)
    if (requestId === undefined) resolve(null)
  })
  child.on('exit', () => {
    for (const resolve of waiting.values()) resolve(null)
    waiting.clear()
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  return { request, raw, close: () => { child.stdin.end(); return exited } }
}

test('the team MCP server lists its tools and forwards calls with the team secret', async () => {
  const desk = await fakeDesk((call) => (call.tool === 'status'
    ? [200, { ok: true, text: 'no children yet' }]
    : [200, { ok: false, error: 'その子はいません' }]))
  const mcp = startMcp(desk.url)
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.deepEqual(init.result.capabilities, { tools: {} })
    // Without an instructions file it adds nothing to the prompt (a Claude leader has its own).
    assert.equal(init.result.instructions, undefined)

    const listed = await mcp.request('tools/list', {})
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['spawn', 'send', 'status', 'wait', 'read_report', 'approve', 'ask_user', 'close'])
    for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, 'object')
    const spawn = listed.result.tools.find((tool) => tool.name === 'spawn')
    assert.deepEqual(spawn.inputSchema.required, ['title', 'task'])
    assert.equal(spawn.inputSchema.properties.model.type, 'string')
    assert.deepEqual(spawn.inputSchema.properties.effort.type, ['string', 'null'])
    assert.match(spawn.inputSchema.properties.effort.description, /null.*default/)
    assert.match(spawn.description, /evenly/)
    const report = listed.result.tools.find((tool) => tool.name === 'read_report')
    assert.match(report.description, /retained text/)
    assert.match(report.description, /unknown completeness in legacy data/)
    assert.match(report.description, /cannot be recovered/)
    assert.doesNotMatch(report.description, /in full/)

    const status = await mcp.request('tools/call', { name: 'status', arguments: {} })
    assert.deepEqual(status.result, { content: [{ type: 'text', text: 'no children yet' }] })
    assert.deepEqual(desk.calls[0], { teamId: 'team-1', secret: 's3cret', tool: 'status', args: {} })

    const failed = await mcp.request('tools/call', { name: 'send', arguments: { child: 'X', message: 'hi' } })
    assert.equal(failed.result.isError, true)
    assert.equal(failed.result.content[0].text, 'その子はいません')

    const unknown = await mcp.request('tools/call', { name: 'rm_rf', arguments: {} })
    assert.equal(unknown.error.code, -32602)
    assert.equal(desk.calls.length, 2)
  } finally {
    await mcp.close()
    desk.close()
  }
})

test('spawn forwards the requested reasoning level, including explicit default', async () => {
  const desk = await fakeDesk(() => [200, { ok: true, text: 'started' }])
  const mcp = startMcp(desk.url)
  try {
    for (const effort of ['high', null]) {
      const args = { title: 'job', task: 'work', provider: 'gpt', model: 'gpt-6-luna', effort }
      assert.equal((await mcp.request('tools/call', { name: 'spawn', arguments: args })).result.content[0].text, 'started')
      assert.deepEqual(desk.calls.at(-1).args, args)
    }
    const args = { title: 'job', task: 'work' }
    await mcp.request('tools/call', { name: 'spawn', arguments: args })
    assert.deepEqual(desk.calls.at(-1).args, args)
  } finally {
    await mcp.close()
    desk.close()
  }
})

test('eco MCP preserves multiline conflict details in tool errors', async () => {
  const diagnostic = [
    '同じフォルダで別のタスクが作業中です',
    '競合タスク: {"kind":"thread","title":"別の作業","id":"writer-1"}',
    '対象フォルダ: "F:\\\\project\\\\nested"',
    '競合フォルダ: "F:\\\\project"',
    'フォルダ関係: 上位（競合側が対象を含む）',
    '判定状態: {"status":"running","permissionMode":"workspace-write"}',
  ].join('\n')
  const desk = await fakeDesk(() => [200, { ok: false, error: diagnostic }])
  const mcp = startMcp(desk.url, { AGENT_DESK_EXECUTION: '1' })
  try {
    const failed = await mcp.request('tools/call', { name: 'spawn', arguments: { title: '実装', task: '範囲内の作業', criteria: '完了条件', checks: [] } })
    assert.equal(failed.result.isError, true)
    assert.equal(failed.result.content[0].text, diagnostic)
  } finally {
    await mcp.close()
    desk.close()
  }
})

test('EX MCP exposes required acceptance criteria, low tier and explicit abandonment', async () => {
  const mcp = startMcp('http://127.0.0.1:9/api/team', { AGENT_DESK_EXECUTION: '1' })
  try {
    const { result } = await mcp.request('tools/list', {})
    const spawn = result.tools.find((tool) => tool.name === 'spawn')
    assert.ok(spawn.inputSchema.required.includes('criteria'))
    assert.ok(spawn.inputSchema.required.includes('checks'))
    assert.deepEqual(spawn.inputSchema.properties.tier.enum, ['low'])
    assert.ok(spawn.inputSchema.required.includes('tier'))
    assert.equal(spawn.inputSchema.properties.model, undefined)
    assert.equal(spawn.inputSchema.properties.effort, undefined)
    assert.deepEqual(spawn.inputSchema.properties.mode.enum, ['write', 'research'])
    assert.match(spawn.description, /Implementation is serial through app verification, limited repairs and parent judgment/)
    assert.match(spawn.description, /close the previous implementation/)
    assert.match(spawn.description, /research may run in parallel and has no app command verification/)
    assert.doesNotMatch(spawn.description, /Close the previous unit/)
    assert.match(result.tools.find((tool) => tool.name === 'read_report').description, /retained text/)
    const implement = result.tools.find((tool) => tool.name === 'implement')
    assert.deepEqual(implement.inputSchema.required, ['child', 'title', 'task', 'criteria', 'checks'])
    assert.equal(implement.inputSchema.properties.fresh, undefined)
    assert.equal(implement.inputSchema.properties.provider, undefined)
    assert.match(implement.description, /same child/)
    const close = result.tools.find((tool) => tool.name === 'close')
    assert.equal(close.inputSchema.properties.accept.type, 'boolean')
    assert.ok(close.inputSchema.required.includes('reason'))
    assert.match(close.inputSchema.properties.reason.description, /what you inspected/)
    assert.match(spawn.inputSchema.properties.criteria.description, /inspect yourself/)
  } finally { await mcp.close() }
})

test('invalid MCP JSON values do not crash and requests with ids get Invalid Request', async () => {
  const mcp = startMcp('http://127.0.0.1:9/api/team')
  try {
    for (const message of [null, [], 7]) await mcp.raw(message)
    assert.deepEqual((await mcp.request('ping', {})).result, {})

    const invalid = await mcp.raw({ jsonrpc: '2.0', id: 50 })
    assert.deepEqual(invalid.error, { code: -32600, message: 'Invalid Request' })
    assert.deepEqual((await mcp.request('ping', {})).result, {})
  } finally {
    await mcp.close()
  }
})

test('a team the desk no longer knows is reported to the leader as a tool error', async () => {
  const desk = await fakeDesk(() => [403, {}])
  const mcp = startMcp(desk.url)
  try {
    const result = await mcp.request('tools/call', { name: 'status', arguments: {} })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /認めませんでした/)
  } finally {
    await mcp.close()
    desk.close()
  }
})

test('a GPT leader\'s MCP server gives the leader instructions as its own', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-team-mcp-'))
  const file = path.join(dir, 'leader.md')
  await fs.writeFile(file, '# you are the leader\n')
  const mcp = startMcp('http://127.0.0.1:9/api/team', { AGENT_DESK_TEAM_INSTRUCTIONS: file })
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
    assert.equal(init.result.instructions, '# you are the leader')
  } finally {
    await mcp.close()
  }
})

test('eco MCP rejects playbook calls even with a stale TM playbook flag', async () => {
  const desk = await fakeDesk(() => [200, { ok: true, text: 'TM-only body' }])
  const mcp = startMcp(desk.url, { AGENT_DESK_EXECUTION: '1', AGENT_DESK_TEAM_PLAYBOOKS: '1' })
  try {
    const listed = await mcp.request('tools/list', {})
    assert.ok(!listed.result.tools.some((tool) => tool.name === 'playbook'))
    const read = await mcp.request('tools/call', { name: 'playbook', arguments: { name: '改修' } })
    assert.equal(read.error.code, -32602)
    assert.deepEqual(desk.calls, [])
  } finally {
    await mcp.close()
    desk.close()
  }
})

test('the playbook tool is listed only when the user has playbooks', async () => {
  const desk = await fakeDesk((call) => [200, { ok: true, text: `# Playbook: ${call.args.name}` }])
  const mcp = startMcp(desk.url, { AGENT_DESK_TEAM_PLAYBOOKS: '1' })
  try {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
    const listed = await mcp.request('tools/list', {})
    assert.equal(listed.result.tools.at(-1).name, 'playbook')
    const read = await mcp.request('tools/call', { name: 'playbook', arguments: { name: '改修' } })
    assert.equal(read.result.content[0].text, '# Playbook: 改修')
    assert.deepEqual(desk.calls[0], { teamId: 'team-1', secret: 's3cret', tool: 'playbook', args: { name: '改修' } })
  } finally {
    await mcp.close()
    desk.close()
  }
})
