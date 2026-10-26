import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
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
  const queued = pool.get('read-only')
  const paused = pool.pause()
  await Promise.all([stopped, queued, paused])
  assert.equal(runtime.state, 'stopped')
  assert.equal(runtime.child, null, 'shutdown must not leave a queued replacement running')
  await assert.rejects(pool.get('read-only'), /更新しています/)
  pool.resume()
  await pool.get('read-only')
  assert.equal(runtime.state, 'ready')
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
