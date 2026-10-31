import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createSocketServer } from '../server/websocket.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, makeFullState) {
  let settings = { notifications: false }
  const clients = new Map()
  const started = deferred(), gate = deferred(), updated = deferred()
  const server = http.createServer()
  const frames = []
  const seenHello = deferred(), seenBarrier = deferred()
  const broadcast = (event, payload) => {
    // Same delivery rule as server/index.js:488-494, without app dependencies.
    let frame
    for (const [socket] of clients) {
      if (socket.readyState === socket.OPEN) socket.send(frame ??= JSON.stringify({ event, ...payload }))
    }
  }
  const update = () => {
    settings = { notifications: true }
    broadcast('settings', { settings })
    updated.resolve()
  }
  const fullState = makeFullState({ getSettings: () => settings, started, gate, update })
  const { handleUpgrade } = createSocketServer({
    dev: false, clients, fullState, getSettings: () => settings, handlers: { barrier: () => null },
    terminals: { dropClient() {} }, broadcastRemote() {}, scheduleIdleExit() {},
    cancelIdleExit() {}, isShuttingDown: () => false,
  })
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, {
    port: server.address().port, token: 'test-token', remote: false,
    hostOk: (host) => host === '127.0.0.1:' + server.address().port,
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = 'http://127.0.0.1:' + server.address().port
  const client = new WebSocket(origin.replace('http:', 'ws:') + '/ws?t=test-token', { origin })
  t.after(async () => {
    gate.resolve()
    client.terminate()
    for (const socket of clients.keys()) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
  })
  client.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    frames.push(frame)
    if (frame.event === 'hello') seenHello.resolve()
    if (frame.id === 1) seenBarrier.resolve()
  })
  await once(client, 'open')
  await started.promise
  return { gate, update, updated, broadcast, frames, client, seenHello, seenBarrier, origin }
}

async function expectLatestSettings(f) {
  await f.seenHello.promise
  f.client.send(JSON.stringify({ id: 1, type: 'barrier' }))
  await f.seenBarrier.promise
  let current
  for (const frame of f.frames) {
    if (frame.event === 'hello') current = frame.state.settings
    if (frame.event === 'settings') current = frame.settings
  }
  const sequence = f.frames.map((frame) => frame.event === 'hello'
    ? ['hello', frame.state.settings.notifications]
    : frame.event === 'settings' ? ['settings', frame.settings.notifications] : ['reply'])
  assert.equal(current?.notifications, true, 'latest settings must survive hello; frames: ' + JSON.stringify(sequence))
}

test('settings saved while fullState awaits accounts survive the initial hello', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, ({ getSettings, started, gate }) => async () => {
    // Matches evaluation order in index.js: settings captured before accounts awaits.
    const settings = getSettings()
    started.resolve()
    await gate.promise
    return { settings, accounts: {} }
  })
  f.update()
  f.gate.resolve()
  await expectLatestSettings(f)
})

test('a settings change in the microtask after snapshot capture survives hello', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, ({ getSettings, started, gate, update }) => async () => {
    started.resolve()
    // Even if accounts() is moved before the synchronous snapshot collection,
    // another microtask can run before websocket.js resumes after await fullState.
    await gate.promise
    const settings = getSettings()
    queueMicrotask(update)
    return { settings, accounts: {} }
  })
  f.gate.resolve()
  await f.updated.promise
  await expectLatestSettings(f)
})

test('an event older than the thread snapshot must not overwrite that snapshot', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, ({ getSettings, started, gate }) => async () => {
    started.resolve()
    await gate.promise
    return { settings: getSettings(), threads: [{ id: 'task', status: 'running' }] }
  })
  // This happened before the snapshot; blindly replaying it after hello is wrong.
  f.broadcast('thread', { thread: { id: 'task', status: 'idle' } })
  f.gate.resolve()
  await f.seenHello.promise
  f.client.send(JSON.stringify({ id: 1, type: 'barrier' }))
  await f.seenBarrier.promise
  let status
  for (const frame of f.frames) {
    if (frame.event === 'hello') status = frame.state.threads[0].status
    if (frame.event === 'thread') status = frame.thread.status
  }
  assert.equal(status, 'running')
})

test('settings saved during a replacement connection survive its hello', { timeout: 5000 }, async (t) => {
  const secondStarted = deferred(), secondGate = deferred()
  let connections = 0
  const f = await fixture(t, ({ getSettings, started }) => async () => {
    const settings = getSettings()
    if (++connections === 1) {
      started.resolve()
      return { settings }
    }
    secondStarted.resolve()
    await secondGate.promise
    return { settings }
  })
  t.after(() => secondGate.resolve())
  await f.seenHello.promise
  const closed = once(f.client, 'close')
  f.client.close()
  await closed

  const client = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws?t=test-token', { origin: f.origin })
  t.after(() => client.terminate())
  const frames = [], seenHello = deferred(), seenBarrier = deferred()
  client.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    frames.push(frame)
    if (frame.event === 'hello') seenHello.resolve()
    if (frame.id === 1) seenBarrier.resolve()
  })
  await once(client, 'open')
  await secondStarted.promise
  f.update()
  secondGate.resolve()
  await expectLatestSettings({ client, frames, seenHello, seenBarrier })
})

test('refreshing hello settings leaves the fullState snapshot unchanged', { timeout: 5000 }, async (t) => {
  const settings = Object.freeze({ notifications: false })
  const threads = Object.freeze([{ id: 'task' }])
  const snapshot = Object.freeze({ settings, threads })
  const f = await fixture(t, ({ started, gate }) => async () => {
    started.resolve()
    await gate.promise
    return snapshot
  })
  f.update()
  f.gate.resolve()
  await expectLatestSettings(f)
  assert.equal(snapshot.settings, settings)
  assert.equal(snapshot.settings.notifications, false)
  assert.equal(snapshot.threads, threads)
  assert.deepEqual(f.frames.find((frame) => frame.event === 'hello').state.threads, [{ id: 'task' }])
})
