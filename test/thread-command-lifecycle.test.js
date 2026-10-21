import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { deferred, fixture, pending, tick } from './helpers/thread-manager.js'

function checkpointTurn(f, threadId = f.thread.id) {
  const turn = {
    id: randomUUID(), status: 'done', startedAt: Date.now(), endedAt: Date.now(),
    user: { text: 'edit', images: [] }, items: [], checkpoint: { before: 'before' },
  }
  f.manager.turns.get(threadId).push(turn)
  return turn
}

async function idleSession(f) {
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const done = f.manager.active.get(f.thread.id).done
  f.finish.resolve()
  await done
}

for (const operation of ['closeSession', 'setOption']) {
  test(`remove waits for update's ${operation} and suppresses late notifications`, async (t) => {
    const f = await fixture(t)
    await idleSession(f)
    const entered = deferred()
    const release = deferred()
    f.runtime[operation] = async (sessionId) => {
      entered.resolve()
      await release.promise
      if (operation === 'closeSession') f.runtime.liveSessions.delete(sessionId)
      return []
    }
    f.manager.catalog = { learn: () => true, snapshot: () => ({}) }
    const events = []
    f.manager.on('thread', () => events.push('thread'))
    f.manager.on('catalog', () => events.push('catalog'))
    f.manager.on('removed', () => events.push('removed'))
    const updating = f.manager.update(f.thread.id, operation === 'closeSession'
      ? { permissionMode: 'read-only' } : { model: '["test","other"]' })
    const rejected = assert.rejects(updating, /削除/)
    await entered.promise
    const removal = f.manager.remove(f.thread.id)
    await pending(removal)
    release.resolve()
    await rejected
    await removal
    await tick()
    assert.deepEqual(events, ['removed'])
    assert.equal(f.manager.liveOptions.size, 0)
    assert.equal(f.manager.sessionIndex.size, 0)
    await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
  })
}

test('restore fences sibling sends and sibling restores in the same workspace', async (t) => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture(t, { checkpointsEnabled: () => false, checkpoints: {
    async restore() { entered.resolve(); await release.promise; return { restored: ['file'], removed: [], undo: 'undo', error: null } },
    async forget() {},
  } })
  const turn = checkpointTurn(f)
  const sibling = await f.manager.create({ workspace: f.base, model: '["test","model"]' })
  const siblingTurn = checkpointTurn(f, sibling.id)
  const restoring = f.manager.restoreCheckpoint(f.thread.id, turn.id)
  await entered.promise
  assert.equal(f.manager.busy, true)
  await assert.rejects(f.manager.send(sibling.id, { text: 'must wait' }), /復元中/)
  await assert.rejects(f.manager.restoreCheckpoint(sibling.id, siblingTurn.id), /復元中/)
  assert.equal(f.calls.sessions, 0)
  release.resolve()
  assert.deepEqual(await restoring, { files: 1, error: null })
  assert.equal(f.manager.busy, false)
  assert.equal((await f.manager.send(sibling.id, { text: 'after restore' })).status, 'accepted')
})

test('send rechecks the workspace restore fence after account validation', async (t) => {
  const validating = deferred()
  const accounts = deferred()
  const restoring = deferred()
  const restoreResult = deferred()
  const f = await fixture(t, {
    getAccounts: async () => { validating.resolve(); return accounts.promise },
    checkpointsEnabled: () => false,
    checkpoints: {
      async restore() { restoring.resolve(); return restoreResult.promise },
      async forget() {},
    },
  })
  const turn = checkpointTurn(f)
  const sibling = await f.manager.create({ workspace: f.base, model: '["test","model"]' })
  const sending = f.manager.send(sibling.id, { text: 'must not run during restore' })
  const rejected = assert.rejects(sending, /復元中/)
  await validating.promise
  const restoration = f.manager.restoreCheckpoint(f.thread.id, turn.id)
  await restoring.promise
  accounts.resolve({})
  await rejected
  assert.equal(f.calls.sessions, 0)
  restoreResult.resolve({ restored: [], removed: [], undo: 'undo', error: null })
  await restoration
  assert.equal(f.manager.busy, false)
})

test('restore failure releases its workspace fence and busy flag', async (t) => {
  const f = await fixture(t, { checkpointsEnabled: () => false, checkpoints: {
    async restore() { throw new Error('restore failed') },
    async forget() {},
  } })
  const turn = checkpointTurn(f)
  await assert.rejects(f.manager.restoreCheckpoint(f.thread.id, turn.id), /restore failed/)
  assert.equal(f.manager.busy, false)
  assert.equal(f.manager.restoring.size, 0)
  assert.equal((await f.manager.send(f.thread.id, { text: 'retry after failure' })).status, 'accepted')
})

for (const operation of ['restoreCheckpoint', 'undoRestore']) {
  test(`shutdown waits for ${operation} and persists its completed metadata`, async (t) => {
    const entered = deferred()
    const release = deferred()
    const f = await fixture(t, { checkpoints: {
      async restore() { entered.resolve(); return release.promise },
      async forget() {},
    } })
    const turn = checkpointTurn(f)
    if (operation === 'undoRestore') {
      turn.restore = { at: Date.now(), undo: 'undo', turns: 1 }
      turn.revertedBy = turn.id
      f.manager.threads.get(f.thread.id).restoreNote = { turnId: turn.id }
    }
    const restoration = f.manager[operation](f.thread.id, turn.id)
    await entered.promise
    const events = []
    f.manager.on('thread', () => events.push('thread'))
    f.manager.on('turn', () => events.push('turn'))
    const shutdown = f.manager.shutdown()
    await pending(shutdown)
    assert.equal(f.manager.busy, true)
    release.resolve({ restored: ['file'], removed: [], undo: 'new-undo', error: null })
    await restoration
    await shutdown
    assert.equal(f.manager.busy, false)
    assert.deepEqual(events, [])
    const saved = (await f.disk()).turns[0]
    if (operation === 'undoRestore') {
      assert.equal(saved.restore, undefined)
      assert.equal(saved.revertedBy, undefined)
    } else {
      assert.equal(saved.restore.undo, 'new-undo')
      assert.equal(saved.restore.files, 1)
      assert.equal(saved.revertedBy, saved.id)
    }
  })
}

test('remove waits for a restore before deleting transcript and forgetting snapshots', async (t) => {
  const entered = deferred()
  const release = deferred()
  const order = []
  const f = await fixture(t, { checkpoints: {
    async restore() { entered.resolve(); await release.promise; order.push('restore'); return { restored: [], removed: [], undo: 'undo', error: null } },
    async forget() { order.push('forget') },
  } })
  const turn = checkpointTurn(f)
  const restoration = f.manager.restoreCheckpoint(f.thread.id, turn.id)
  await entered.promise
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  release.resolve()
  await restoration
  await removal
  assert.deepEqual(order, ['restore', 'forget'])
  assert.equal(f.manager.busy, false)
  assert.equal(f.manager.turns.has(f.thread.id), false)
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
})

test('create refuses shutdown both before and after directory validation', async (t) => {
  const f = await fixture(t)
  const stat = await fs.stat(f.base)
  const entered = deferred()
  const release = deferred()
  const original = fs.stat
  let validations = 0
  t.mock.method(fs, 'stat', async (file, ...args) => {
    if (file !== f.base) return original(file, ...args)
    validations++
    entered.resolve()
    return release.promise
  })
  const events = []
  f.manager.on('thread', (thread) => events.push(thread))
  const creating = f.manager.create({ workspace: f.base, model: '["test","model"]' })
  const rejected = assert.rejects(creating, /終了/)
  await entered.promise
  await f.manager.shutdown()
  await assert.rejects(f.manager.create({ workspace: f.base, model: '["test","model"]' }), /終了/)
  assert.equal(validations, 1)
  release.resolve(stat)
  await rejected
  assert.equal(f.manager.list().length, 1)
  assert.deepEqual(events, [])
  assert.equal(JSON.parse(await fs.readFile(f.paths.threadsIndex, 'utf8')).threads.length, 1)
})

for (const operation of ['get', 'checkpointPreview']) {
  test(`${operation} cannot repopulate a transcript cache while removal waits for its read`, async (t) => {
    let previews = 0
    const f = await fixture(t, { checkpoints: {
      async preview() { previews++; return [] },
      async forget() {},
    } })
    const turn = checkpointTurn(f)
    const content = JSON.stringify({ version: 1, turns: [turn] })
    await fs.mkdir(f.paths.threadsDir, { recursive: true })
    await fs.writeFile(f.turnFile, content)
    f.manager.turns.delete(f.thread.id)
    f.manager.receipts.delete(f.thread.id)
    const entered = deferred()
    const release = deferred()
    const original = fs.readFile
    t.mock.method(fs, 'readFile', async (file, ...args) => {
      if (file !== f.turnFile) return original(file, ...args)
      entered.resolve()
      return release.promise
    })
    const reading = f.manager[operation](f.thread.id, turn.id)
    const rejected = assert.rejects(reading, /削除/)
    await entered.promise
    const removal = f.manager.remove(f.thread.id)
    await pending(removal)
    release.resolve(content)
    await rejected
    await removal
    assert.equal(previews, 0)
    assert.equal(f.manager.turnLoads.size, 0)
    assert.equal(f.manager.turns.has(f.thread.id), false)
    assert.equal(f.manager.receipts.has(f.thread.id), false)
    await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
  })
}
