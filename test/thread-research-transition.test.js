import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, deferred } from './helpers/thread-manager.js'

async function research(t) {
  const f = await fixture(t)
  const thread = f.manager.threads.get(f.thread.id)
  thread.permissionMode = 'read-only'
  thread.team = { id: 'team', childId: 'child', executionMode: 'research' }
  await f.manager.send(thread.id, { text: 'investigate this scope' })
  await f.started.promise
  const active = f.manager.active.get(thread.id)
  f.finish.resolve()
  await active.done
  const sessions = new Set()
  const writer = {
    liveSessions: sessions,
    async resumeSession(id) { sessions.add(id); return { configOptions: [] } },
    async closeSession(id) { sessions.delete(id) },
    async setOption() { return [] },
    async prompt(id, blocks) { f.calls.prompts.push({ sessionId: id, blocks }); return { stopReason: 'end_turn' } },
    async newSession() { throw new Error('must not replace the investigation session') },
  }
  const previousHolder = f.pool.holderOf
  f.pool.get = async (key) => key === 'team:danger-full-access' ? writer : f.runtime
  f.pool.holderOf = (id) => sessions.has(id) ? writer : previousHolder(id)
  return { ...f, thread, writer }
}

test('research implementation keeps session ID and transcript; ordinary updates still cannot elevate research', async (t) => {
  const f = await research(t)
  const sessionId = f.thread.sessionId
  await assert.rejects(f.manager.update(f.thread.id, { permissionMode: 'danger-full-access' }), /読み取り専用/)
  await f.manager.implementResearch(f.thread.id)
  await f.manager.implementResearch(f.thread.id) // retrying a committed transition is harmless
  assert.equal(f.thread.sessionId, sessionId)
  assert.equal(f.thread.permissionMode, 'danger-full-access')
  assert.equal(f.thread.team.executionMode, 'write')
  assert.equal(f.thread.carryover, undefined)
  assert.equal(f.calls.sessions, 1)
  assert.deepEqual(f.calls.closed, [sessionId])
  const view = await f.manager.get(f.thread.id)
  assert.equal(view.turns[0].user.text, 'investigate this scope')
  await f.manager.send(f.thread.id, { text: 'implement this scope' })
  await f.manager.active.get(f.thread.id).done
  assert.equal(f.calls.prompts.at(-1).sessionId, sessionId)
  assert.deepEqual(f.calls.prompts.at(-1).blocks, [{ type: 'text', text: 'implement this scope' }])
})

test('missing research logs fail closed without falling back to a new session', async (t) => {
  const f = await research(t)
  const sessionId = f.thread.sessionId
  f.writer.resumeSession = async () => { throw new Error('missing history') }
  await assert.rejects(f.manager.implementResearch(f.thread.id), /missing history/)
  assert.equal(f.thread.sessionId, sessionId)
  assert.equal(f.thread.permissionMode, 'read-only')
  assert.equal(f.thread.team.executionMode, 'research')
  assert.equal(f.calls.sessions, 1)
})

test('failed transition persistence restores research and closes the writer session', async (t) => {
  const f = await research(t)
  const flush = f.manager.indexWriter.flush.bind(f.manager.indexWriter)
  f.manager.indexWriter.flush = async () => { throw new Error('cannot save transition') }
  await assert.rejects(f.manager.implementResearch(f.thread.id), /cannot save transition/)
  f.manager.indexWriter.flush = flush
  assert.equal(f.thread.permissionMode, 'read-only')
  assert.equal(f.thread.team.executionMode, 'research')
  assert.equal(f.writer.liveSessions.size, 0)
})

test('removal waits for an in-flight research transition and cannot resurrect its session', async (t) => {
  const f = await research(t)
  const started = deferred(), resume = deferred()
  f.writer.resumeSession = async (id) => {
    started.resolve()
    await resume.promise
    f.writer.liveSessions.add(id)
    return { configOptions: [] }
  }
  const transition = f.manager.implementResearch(f.thread.id)
  await started.promise
  const removing = f.manager.remove(f.thread.id)
  resume.resolve()
  await assert.rejects(transition, /削除/)
  await removing
  assert.equal(f.manager.threads.has(f.thread.id), false)
  assert.equal(f.writer.liveSessions.size, 0)
})
