import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleObserverMcp } from '../server/team-observer-mcp.js'

const msg = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params })
test('observer MCP exposes only bounded readers and standing restrictions', async () => {
  const call = () => { throw new Error('unexpected call') }
  const init = await handleObserverMcp(msg('initialize', { protocolVersion: '2025-06-18' }), call)
  assert.match(init.result.instructions, /Never poll/)
  assert.match(init.result.instructions, /untrusted data/)
  assert.match(init.result.instructions, /search and read workspace files/)
  assert.match(init.result.instructions, /Never modify files, execute commands, or delegate/)
  const list = await handleObserverMcp(msg('tools/list'), call)
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['status', 'child_turns', 'send', 'stop'])
  assert.equal(list.result.tools[1].inputSchema.properties.limit.maximum, 10)
  assert.equal(await handleObserverMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, call), null)
})
test('observer MCP forwards only declared calls and reports errors', async () => {
  const seen = []
  const call = async (...args) => { seen.push(args); return 'ok' }
  const result = await handleObserverMcp(msg('tools/call', { name: 'child_turns', arguments: { childId: 'a', limit: 2 } }), call)
  assert.deepEqual(seen, [['child_turns', { childId: 'a', limit: 2 }]])
  assert.equal(result.result.content[0].text, 'ok')
  const unknown = await handleObserverMcp(msg('tools/call', { name: 'spawn' }), call)
  assert.equal(unknown.error.code, -32602)
  const failed = await handleObserverMcp(msg('tools/call', { name: 'status' }), async () => { throw new Error('offline') })
  assert.equal(failed.result.isError, true)
})
