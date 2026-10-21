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
  const exited = new Promise((resolve) => child.on('exit', resolve))
  return { request, close: () => { child.stdin.end(); return exited } }
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
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['spawn', 'send', 'status', 'read_report', 'approve', 'ask_user', 'close'])
    for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, 'object')

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
