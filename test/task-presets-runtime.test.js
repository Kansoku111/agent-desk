import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RuntimePool, runtimeKey } from '../server/runtime.js'
import { appPaths } from '../server/paths.js'
import { writeHomePatch, writeTaskPresetPatch } from '../server/dsh-config.js'

for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
  test(`preset ${mode} selects its own lazy runtime and preserves its policy`, async (t) => {
    const pool = new RuntimePool({ paths: { taskPresetPatch: 'preset.patch.yml' }, onUpdate() {}, onPermission() {} })
    const key = runtimeKey({ preset: { runId: 'review' }, permissionMode: mode })
    const runtime = pool.runtimes.get(key)
    assert.ok(runtime, `missing runtime: ${key}`)
    assert.equal(runtime.state, 'stopped')
    assert.equal(runtime.mode, mode)
    assert.deepEqual(runtime.patches, ['preset.patch.yml'])
    assert.notEqual(runtime, pool.runtimes.get(mode))
    const start = t.mock.method(runtime, 'start', async () => runtime)
    assert.equal(await pool.get(key), runtime)
    assert.equal(start.mock.callCount(), 1)
    let exit
    pool.once('exit', (event) => { exit = event })
    runtime.emit('exit', { code: 1, wasReady: true })
    assert.deepEqual(exit, { mode, key, code: 1, wasReady: true })
  })
}

test('opinion preset opens a read-only ACP session using the production pool and patch', { timeout: 60_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-opinion-runtime-'))
  const paths = appPaths(home)
  const pool = new RuntimePool({ paths, onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  t.after(async () => {
    await pool.stopAll()
    assert.equal(path.dirname(home), os.tmpdir())
    assert.ok(path.basename(home).startsWith('preset-opinion-runtime-'))
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  await writeHomePatch(paths.homePatch)
  await writeTaskPresetPatch(paths.taskPresetPatch)
  const runtime = await pool.get(runtimeKey({ preset: { runId: 'opinion' }, permissionMode: 'read-only' }))
  const session = await runtime.newSession(home, [])
  const policy = session.configOptions.find((option) => option.id === 'agent_desk_session_policy')
  assert.equal(policy.currentValue, 'read-only')
  assert.ok(runtime.liveSessions.has(session.sessionId))
  await runtime.closeSession(session.sessionId)
})
