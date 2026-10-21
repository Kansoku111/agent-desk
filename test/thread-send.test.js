import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ThreadManager } from '../server/threads.js'

test('two sends that arrive together start one turn; the other is refused', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-send-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  let finish
  const prompts = []
  const runtime = {
    liveSessions: new Set(),
    async newSession() {
      const sessionId = `s-${this.liveSessions.size + 1}`
      this.liveSessions.add(sessionId)
      return { sessionId, configOptions: [] }
    },
    async setOption() {
      return []
    },
    async prompt(_sessionId, blocks) {
      prompts.push(blocks.map((block) => block.text).join('\n'))
      await new Promise((resolve) => { finish = resolve })
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
    async closeSession() {},
  }
  const pool = Object.assign(new EventEmitter(), {
    get: async () => runtime,
    holderOf: (sessionId) => (runtime.liveSessions.has(sessionId) ? runtime : null),
    status: () => ({}),
  })
  const manager = new ThreadManager({
    paths: {
      threadsIndex: path.join(base, 'threads.json'),
      threadsDir: path.join(base, 'threads'),
      attachmentsDir: path.join(base, 'attachments'),
      dshHome: path.join(base, 'dsh-home'),
      runtimeCwd: path.join(base, 'runtime'),
    },
    pool,
    catalog: { learn: () => false },
    // Slow enough that both sends pass the first check before either starts.
    getAccounts: () => new Promise((resolve) => setTimeout(() => resolve({}), 20)),
    getTurnUsage: async () => null,
  })
  t.after(() => manager.shutdown())

  const thread = await manager.create({ workspace: base, model: '["test","model"]' })
  const results = await Promise.allSettled([
    manager.send(thread.id, { text: 'first' }),
    manager.send(thread.id, { text: 'second' }),
  ])
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected'])
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /まだ作業中/)
  const { turns } = await manager.get(thread.id)
  assert.equal(turns.length, 1)

  for (let attempt = 0; attempt < 200 && !finish; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  finish()
  for (let attempt = 0; attempt < 200 && manager.busy; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(prompts.length, 1)
})
