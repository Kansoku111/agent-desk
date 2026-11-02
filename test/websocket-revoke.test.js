import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createSocketServer } from '../server/websocket.js'

// A new link (remote.rotate) or turning remote access off closes every phone's
// socket (index.js disconnectRemote). ws keeps delivering frames while it waits
// up to 30 s for the peer's close reply, so a phone that never answers must not
// get its requests run in that window.
test('a socket the server is closing no longer runs requests', { timeout: 5000 }, async (t) => {
  const clients = new Map()
  const calls = []
  const server = http.createServer()
  const { handleUpgrade } = createSocketServer({
    dev: false, clients, fullState: async () => ({}), getSettings: () => ({}),
    handlers: { act: (params) => { calls.push(params) } },
    terminals: { dropClient() {} }, broadcastRemote() {}, scheduleIdleExit() {},
    cancelIdleExit() {}, isShuttingDown: () => false,
  })
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, {
    port: server.address().port, token: 'phone-token', remote: true,
    hostOk: (host) => host === '127.0.0.1:' + server.address().port,
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = 'http://127.0.0.1:' + server.address().port
  const client = new WebSocket(origin.replace('http:', 'ws:') + '/ws?t=phone-token', { origin })
  t.after(async () => {
    client.terminate()
    for (const socket of clients.keys()) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
  })
  const hello = once(client, 'message')
  await once(client, 'open')
  await hello

  const [serverSocket] = clients.keys()
  client.send(JSON.stringify({ id: 1, type: 'act', n: 1 }))
  await once(serverSocket, 'message')
  assert.deepEqual(calls, [{ n: 1 }], 'an open socket runs requests')

  // The phone stops reading, so it never sees the close frame or answers it.
  client._socket.pause()
  serverSocket.close(4001, 'remote access ended')
  assert.equal(serverSocket.readyState, serverSocket.CLOSING)
  client.send(JSON.stringify({ id: 2, type: 'act', n: 2 }))
  // websocket.js's listener was added first, so it has run when this one fires.
  await once(serverSocket, 'message')
  assert.deepEqual(calls, [{ n: 1 }], 'a request after the server closed the socket must not run')
})
