import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ThreadManager } from '../../server/threads.js'

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve))

export async function pending(promise) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await tick()
  assert.equal(settled, false, 'operation must still be waiting')
}

/** All files and fake sessions belong to this test's temporary directory. */
export async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-thread-'))
  const started = deferred()
  const finish = deferred()
  const calls = { sessions: 0, prompts: [], steers: [], closed: [] }
  const runtime = {
    liveSessions: new Set(),
    async newSession() {
      const sessionId = `session-${++calls.sessions}`
      this.liveSessions.add(sessionId)
      return { sessionId, configOptions: [] }
    },
    async setOption(_sessionId, id, value) { return id === 'agent_desk_tool_mode' ? [{ id, currentValue: value }] : [] },
    async prompt(sessionId, blocks) {
      calls.prompts.push({ sessionId, blocks })
      started.resolve()
      await finish.promise
      return { stopReason: 'end_turn' }
    },
    async steer(sessionId, blocks) {
      calls.steers.push({ sessionId, blocks })
      return true
    },
    async cancel() { finish.resolve() },
    async closeSession(sessionId) {
      calls.closed.push(sessionId)
      this.liveSessions.delete(sessionId)
    },
  }
  const pool = Object.assign(new EventEmitter(), {
    get: async () => runtime,
    holderOf: (id) => runtime.liveSessions.has(id) ? runtime : null,
    status: () => ({}),
  })
  const paths = {
    threadsIndex: path.join(base, 'index.json'),
    threadsDir: path.join(base, 'threads'),
    attachmentsDir: path.join(base, 'attachments'),
    dshHome: path.join(base, 'dsh-home'),
    runtimeCwd: path.join(base, 'runtime'),
  }
  const managers = []
  const makeManager = (overrides = {}) => {
    const manager = new ThreadManager({ paths, pool, catalog: { learn: () => false }, getAccounts: async () => ({}), getTurnUsage: async () => null, ...options, ...overrides })
    managers.push(manager)
    return manager
  }
  const manager = makeManager()
  const thread = await manager.create({ workspace: base, model: '["test","model"]', toolMode: 'native' })
  t.after(async () => {
    finish.resolve()
    for (const entry of managers) await entry.shutdown()
    await fs.rm(base, { recursive: true, force: true })
  })
  return {
    base, paths, manager, thread, runtime, pool, calls, started, finish, makeManager,
    turnFile: path.join(paths.threadsDir, `${thread.id}.json`),
    async disk() { return JSON.parse(await fs.readFile(this.turnFile, 'utf8')) },
  }
}
