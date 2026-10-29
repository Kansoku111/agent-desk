import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { ThreadManager } from '../server/threads.js'
import { createSettingsService } from '../server/settings.js'
import { fixture } from './helpers/thread-manager.js'


test('thread RPC only marks accepted human input, never validation failures or an internal retry', async (t) => {
  const f = await fixture(t)
  let answered = 0
  f.manager.userMessageAccepted = () => answered++
  const handlers = createThreadHandlers({ paths: f.paths, threads: f.manager,
    teams: { userWrote() { assert.fail('the RPC must not clear questions before acceptance') } },
    subagents: { list: async () => [] } })
  await assert.rejects(handlers['thread.send']({ threadId: f.thread.id, text: '', images: [] }))
  assert.equal(answered, 0)
  const message = { threadId: f.thread.id, text: 'the answer', images: [], messageId: 'ef4eddc9-01fa-4f15-8567-86c72d5164f3' }
  await handlers['thread.send'](message)
  await f.started.promise
  assert.equal(answered, 1)
  await handlers['thread.send'](message)
  assert.equal(answered, 1)
  await assert.rejects(handlers['thread.send']({ threadId: f.thread.id, text: 'not accepted', images: [] }), /まだ作業中/)
  assert.equal(answered, 1)
})

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

  const thread = await manager.create({ workspace: base, model: '["test","model"]', toolMode: 'native' })
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

test('a summary for a new session is kept when the prompt that would carry it fails', async (t) => {
  const f = await fixture(t)
  const delivered = []
  let failNext = false
  f.runtime.prompt = async (_sessionId, blocks) => {
    if (failNext) {
      failNext = false
      throw new Error('ACP connection closed')
    }
    delivered.push(blocks.map((block) => block.text).join('\n'))
    return { stopReason: 'end_turn' }
  }
  const finished = () => new Promise((resolve) => f.manager.once('turn-finished', resolve))
  let done = finished()
  await f.manager.send(f.thread.id, { text: 'first question' })
  assert.equal((await done).status, 'done')
  await f.manager.update(f.thread.id, { permissionMode: 'read-only' })
  failNext = true
  done = finished()
  await f.manager.send(f.thread.id, { text: 'second' })
  assert.equal((await done).status, 'error')
  done = finished()
  await f.manager.send(f.thread.id, { text: 'third' })
  assert.equal((await done).status, 'done')
  assert.match(delivered.at(-1), /previous_conversation/)
  assert.match(delivered.at(-1), /first question/)
})

test('a task whose settings cannot be saved is still reported as created, and its first message is sent once', async (t) => {
  const f = await fixture(t)
  const settings = { workspaces: [], lastWorkspace: null, defaultModel: null, defaultEffort: '', defaultPermissionMode: 'workspace-write' }
  const before = structuredClone(settings)
  const service = createSettingsService({
    getSettings: () => settings,
    saveSettings: async () => { throw new Error('EPERM: settings file is locked') },
    publishSettings: () => { assert.fail('must not publish after a failed save') },
  })
  const handlers = createThreadHandlers({
    paths: f.paths,
    threads: f.manager,
    teams: { userWrote() {} },
    subagents: { list: async () => [] },
    mutateSettings: (...args) => service.mutate(...args),
  })
  const warn = t.mock.method(console, 'warn', () => {})
  const { thread } = await handlers['thread.create']({ workspace: f.base, model: '["test","model"]', text: 'hello', images: [] })
  await f.started.promise
  assert.equal(f.calls.prompts.length, 1)
  assert.equal(f.manager.threads.get(thread.id).id, thread.id)
  assert.equal(warn.mock.calls.length, 1)
  assert.match(warn.mock.calls[0].arguments[0], /saving settings failed/)
  assert.match(warn.mock.calls[0].arguments[1], /settings file is locked/)
  assert.deepEqual(settings, before)
})
