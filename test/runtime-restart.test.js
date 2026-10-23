import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { appPaths } from '../server/paths.js'
import { AcpRuntime } from '../server/runtime.js'

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
