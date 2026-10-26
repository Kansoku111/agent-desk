import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ClientSideConnection } from '@agentclientprotocol/sdk'
import { appPaths } from '../server/paths.js'
import { AcpRuntime, RuntimePool } from '../server/runtime.js'

for (const whileStarting of [false, true]) {
  test(`a start during runtime recycling waits for shutdown and uses a fresh connection (${whileStarting ? 'starting' : 'ready'})`, { timeout: 60_000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-recycle-'))
    const runtime = new AcpRuntime({ mode: 'read-only', paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}) })
    t.after(async () => {
      await runtime.stop(1000)
      assert.equal(path.dirname(home), os.tmpdir())
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })
    const first = runtime.start()
    if (!whileStarting) await first
    const stopping = runtime.stop()
    assert.equal(runtime.stop(), stopping, 'overlapping restarts share one shutdown')
    const restarting = Promise.all([runtime.start(), runtime.start()])
    const old = await first
    const child = old.child
    await stopping
    await restarting
    assert.equal(runtime.state, 'ready', 'the next request must not use a stopping runtime')
    assert.ok(runtime.child)
    assert.notEqual(runtime.child, child)
    const session = await runtime.newSession(home)
    assert.ok(runtime.liveSessions.has(session.sessionId))
    await runtime.closeSession(session.sessionId)
  })
}

test('a pool get already waiting on a ready runtime follows a concurrent recycle', { timeout: 60_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-get-recycle-'))
  const pool = new RuntimePool({ paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}) })
  t.after(async () => {
    await pool.pause()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const runtime = await pool.get('read-only')
  const child = runtime.child
  const getting = pool.get('read-only')
  const stopping = pool.stopAll()
  const received = await getting
  await stopping
  assert.equal(received.state, 'ready')
  assert.notEqual(received.child, child)
  const session = await received.newSession(home)
  await received.closeSession(session.sessionId)
})

test('pausing the pool drains a start queued behind runtime recycling', { timeout: 60_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-pause-'))
  const pool = new RuntimePool({ paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}) })
  t.after(async () => {
    await pool.pause()
    assert.equal(path.dirname(home), os.tmpdir())
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const runtime = await pool.get('read-only')
  const stopped = runtime.stop()
  const start = t.mock.method(runtime, 'start')
  const queued = pool.get('read-only')
  const rejected = assert.rejects(queued, /更新しています/)
  const paused = pool.pause()
  await Promise.all([stopped, rejected, paused])
  assert.equal(start.mock.callCount(), 0, 'a paused pool must not start a replacement')
  assert.equal(runtime.state, 'stopped')
  assert.equal(runtime.child, null, 'shutdown must not leave a queued replacement running')
  await assert.rejects(pool.get('read-only'), /更新しています/)
  pool.resume()
  await pool.get('read-only')
  assert.equal(runtime.state, 'ready')
})

test('pausing rejects a pool get already waiting for startup', { timeout: 60_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-pause-starting-'))
  const pool = new RuntimePool({ paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}) })
  t.after(async () => {
    await pool.pause()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const runtime = pool.runtimes.get('read-only')
  const getting = pool.get('read-only')
  const rejected = assert.rejects(getting, /更新しています/)
  await Promise.all([pool.pause(), rejected])
  assert.equal(runtime.child, null)
  assert.equal(runtime.state, 'stopped')
})

test('stopping a stalled startup respects the shutdown grace period', { timeout: 15_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-stalled-start-'))
  const runtime = new AcpRuntime({ mode: 'read-only', paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}), startTimeoutMs: 10_000 })
  t.after(async () => {
    await runtime.stop(1000)
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const entered = Promise.withResolvers()
  const initialize = t.mock.method(ClientSideConnection.prototype, 'initialize', () => {
    entered.resolve()
    return new Promise(() => {})
  })
  const first = runtime.start()
  const failed = assert.rejects(first)
  await entered.promise
  const child = runtime.child
  let watchdogFired = false
  const watchdog = setTimeout(() => { watchdogFired = true; child.kill() }, 2000)
  try {
    await runtime.stop(100)
    await failed
  } finally {
    clearTimeout(watchdog)
  }
  assert.equal(watchdogFired, false, 'shutdown must not wait for the 10-second startup timeout')
  assert.equal(runtime.child, null)
  assert.equal(runtime.state, 'stopped')
  initialize.mock.restore()
  await runtime.start()
  assert.notEqual(runtime.child, child)
  assert.equal(runtime.state, 'ready')
})

test('pausing the pool interrupts a stalled startup before the startup timeout', { timeout: 15_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-pause-stalled-'))
  const pool = new RuntimePool({ paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}) })
  const runtime = pool.runtimes.get('read-only')
  runtime.startTimeoutMs = 10_000
  const stop = runtime.stop.bind(runtime)
  t.mock.method(runtime, 'stop', () => stop(100))
  t.after(async () => {
    await pool.pause()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const entered = Promise.withResolvers()
  t.mock.method(ClientSideConnection.prototype, 'initialize', () => {
    entered.resolve()
    return new Promise(() => {})
  })
  const getting = pool.get('read-only')
  const rejected = assert.rejects(getting)
  await entered.promise
  const child = runtime.child
  let watchdogFired = false
  const watchdog = setTimeout(() => { watchdogFired = true; child.kill() }, 2000)
  try {
    await Promise.all([pool.pause(), rejected])
  } finally {
    clearTimeout(watchdog)
  }
  assert.equal(watchdogFired, false, 'pause must start the shutdown deadline immediately')
  assert.equal(runtime.child, null)
  assert.equal(runtime.state, 'stopped')
})

test('a shutdown deadline reached before directory creation prevents a late spawn', { timeout: 15_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-slow-mkdir-'))
  const runtime = new AcpRuntime({ mode: 'read-only', paths: appPaths(home), onUpdate() {}, onPermission: async () => ({}) })
  t.after(async () => {
    await runtime.stop(1000)
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const mkdir = fs.mkdir.bind(fs)
  t.mock.method(fs, 'mkdir', async (dir, ...args) => {
    if (dir === runtime.paths.runtimeCwd) { entered.resolve(); await release.promise }
    return mkdir(dir, ...args)
  })
  const starting = runtime.start()
  const rejected = assert.rejects(starting, /stopped during startup/)
  await entered.promise
  const stopping = runtime.stop(10)
  await new Promise((resolve) => setTimeout(resolve, 50))
  release.resolve()
  await Promise.all([stopping, rejected])
  assert.equal(runtime.child, null)
  assert.equal(runtime.state, 'stopped')
})

test('a start killed by its timeout can exit after the next start spawned; that exit leaves the next start\'s child in place', { timeout: 60_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-runtime-'))
  const runtime = new AcpRuntime({
    mode: 'read-only', paths: appPaths(home), onUpdate: () => {}, onPermission: async () => ({}), startTimeoutMs: 1,
  })
  // Every dsh the runtime starts is recorded, even one it has lost, so a failing run cannot leave it behind.
  const started = []
  let current = null
  Object.defineProperty(runtime, 'child', {
    get: () => current,
    set: (child) => {
      current = child
      if (child) started.push(child)
    },
  })
  t.after(async () => {
    await runtime.stop(1000)
    for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  // No dsh answers within 1 ms, so the first start is killed and its exit is still on its way.
  await assert.rejects(runtime.start())
  runtime.startTimeoutMs = 60_000
  await runtime.start()
  assert.equal(runtime.state, 'ready')
  assert.ok(runtime.child, 'the runtime lost the child it started')
  assert.equal(runtime.child.exitCode, null)
  assert.ok(runtime.conn)
})
