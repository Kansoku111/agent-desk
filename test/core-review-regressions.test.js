import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createSocketServer } from '../server/websocket.js'
import { LogTail } from '../server/subagents.js'
import { fixture } from './helpers/thread-manager.js'

const frame = (...events) => zlib.zstdCompressSync(Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join('')))

test('a malformed WebSocket frame closes only its connection without an uncaught error', async (t) => {
  const clients = new Map()
  const server = http.createServer()
  const { handleUpgrade } = createSocketServer({
    dev: false, clients, handlers: {}, fullState: async () => ({}),
    terminals: { dropClient() {} }, broadcastRemote() {}, scheduleIdleExit() {},
    cancelIdleExit() {}, isShuttingDown: () => false,
  })
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, {
    port: server.address().port, token: 'test-token', remote: false,
    hostOk: (host) => host === `127.0.0.1:${server.address().port}`,
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const client = new WebSocket(`${origin.replace('http:', 'ws:')}/ws?t=test-token`, { origin })
  t.after(async () => {
    client.terminate()
    for (const socket of clients.keys()) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
  })
  await once(client, 'open')
  const closed = once(client, 'close')
  // Client-to-server frames must be masked. ws emits an error on the accepted
  // server socket before closing it when a peer violates this protocol rule.
  client._socket.write(Buffer.from([0x81, 0x01, 0x61]))
  const [code] = await closed
  assert.equal(code, 1002)
})

test('approval-needed listeners can immediately discover and answer the pending permission', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'hello' })
  await f.started.promise
  const options = [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
  let seen
  f.manager.on('approval-needed', ({ threadId }) => {
    seen = f.manager.pendingPermissions(threadId)
    if (seen.length) f.manager.respondPermission(seen[0].requestId, 'allow')
  })
  const response = f.manager.onPermission({
    sessionId: f.manager.threads.get(f.thread.id).sessionId,
    toolCall: { toolCallId: 'tool-1', title: 'read', rawInput: { path: 'a.txt' } }, options,
  })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].options, options)
  assert.deepEqual(await response, { outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.deepEqual(f.manager.pendingPermissions(f.thread.id), [])
  assert.equal(f.manager.threads.get(f.thread.id).pendingApproval, false)
})

test('LogTail rereads a shortened last frame even when its start offset did not shrink', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-tail-recovery-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const first = frame({ type: 'session', id: 's1' }, { type: 'turn/start', seq: 0 })
  const last = frame({ type: 'assistant/message', seq: 1, data: { text: 'a longer message before recovery' } }, { type: 'turn/end', seq: 2 })
  await fs.writeFile(file, Buffer.concat([first, last]))
  const tail = new LogTail(file)
  assert.deepEqual((await tail.read()).map((event) => event.seq), [0, 1, 2])
  assert.equal(tail.offset, first.length)
  const recovered = frame({ type: 'turn/end', seq: 1 })
  assert.ok(recovered.length < last.length)
  await fs.writeFile(file, Buffer.concat([first, recovered]))
  assert.deepEqual((await tail.read()).map((event) => event.seq), [0, 1])
  assert.deepEqual(await tail.read(), [])
})
