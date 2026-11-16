import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ThreadManager } from '../server/threads.js'
import { appPaths } from '../server/paths.js'

test('warming a runtime starts that mode and reports the new state', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-warm-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const started = []
  const pool = Object.assign(new EventEmitter(), {
    get: async (key) => { started.push(key) },
    status: () => ({ 'danger-full-access': started.includes('danger-full-access') ? 'ready' : 'stopped' }),
  })
  const threads = new ThreadManager({ paths: appPaths(home), pool, catalog: { learn: () => false }, getAccounts: async () => ({}) })
  const reported = []
  threads.on('runtime', (status) => reported.push(status))
  await threads.warmRuntime('danger-full-access')
  assert.deepEqual(started, ['danger-full-access'])
  assert.deepEqual(reported, [{ 'danger-full-access': 'ready' }])
})
