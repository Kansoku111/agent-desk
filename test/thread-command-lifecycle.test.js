import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
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

const overlappingWorkspaces = [
  {
    name: 'symlink or junction alias',
    operation: 'restoreCheckpoint',
    async setup(f) {
      const target = path.join(f.base, 'real-workspace')
      const alias = path.join(f.base, 'workspace-alias')
      await fs.mkdir(target)
      await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      return { targetWorkspace: target, activeWorkspace: alias, activeFile: path.join(target, 'active.txt') }
    },
  },
  {
    name: 'parent restore while child workspace is active',
    operation: 'restoreCheckpoint',
    async setup(f) {
      const parent = path.join(f.base, 'parent')
      const child = path.join(parent, 'child')
      await fs.mkdir(child, { recursive: true })
      return { targetWorkspace: parent, activeWorkspace: child, activeFile: path.join(child, 'active.txt') }
    },
  },
  {
    name: 'child undo while parent workspace is active',
    operation: 'undoRestore',
    async setup(f) {
      const parent = path.join(f.base, 'parent')
      const child = path.join(parent, 'child')
      await fs.mkdir(child, { recursive: true })
      return { targetWorkspace: child, activeWorkspace: parent, activeFile: path.join(child, 'active.txt') }
    },
  },
]

for (const scenario of overlappingWorkspaces) {
  test(`${scenario.operation} rejects active overlapping workspace: ${scenario.name}`, async (t) => {
    let activeFile
    let restoreCalls = 0
    const f = await fixture(t, {
      checkpointsEnabled: () => false,
      checkpoints: {
        async restore() {
          restoreCalls++
          await fs.writeFile(activeFile, 'restored checkpoint')
          return { restored: ['active.txt'], removed: [], undo: 'mock-undo', error: null }
        },
        async forget() {},
      },
    })
    const { targetWorkspace, activeWorkspace, activeFile: file } = await scenario.setup(f)
    activeFile = file
    await fs.writeFile(activeFile, 'unsaved active work')
    const target = await f.manager.create({ workspace: targetWorkspace, model: '["test","model"]' })
    const turn = checkpointTurn(f, target.id)
    if (scenario.operation === 'undoRestore') turn.restore = { at: Date.now(), undo: 'mock-undo', turns: 1 }
    const active = await f.manager.create({ workspace: activeWorkspace, model: '["test","model"]' })
    await f.manager.send(active.id, { text: 'active work' })
    await f.started.promise

    const outcome = await f.manager[scenario.operation](target.id, turn.id).then(
      () => ({ blocked: false }),
      (error) => ({ blocked: /同じフォルダ/.test(error.message) }),
    )
    assert.deepEqual({ outcome, restoreCalls, activeFile: await fs.readFile(activeFile, 'utf8') }, {
      outcome: { blocked: true }, restoreCalls: 0, activeFile: 'unsaved active work',
    })
  })
}

for (const otherName of ['sibling', 'project-old']) {
  test(`restore allows an active non-overlapping sibling workspace (${otherName})`, async (t) => {
    let restoreCalls = 0
    const f = await fixture(t, {
      checkpointsEnabled: () => false,
      checkpoints: {
        async restore() { restoreCalls++; return { restored: [], removed: [], undo: 'mock-undo', error: null } },
        async forget() {},
      },
    })
    const targetWorkspace = path.join(f.base, 'project')
    const activeWorkspace = path.join(f.base, otherName)
    await Promise.all([fs.mkdir(targetWorkspace), fs.mkdir(activeWorkspace)])
    const target = await f.manager.create({ workspace: targetWorkspace, model: '["test","model"]' })
    const turn = checkpointTurn(f, target.id)
    const active = await f.manager.create({ workspace: activeWorkspace, model: '["test","model"]' })
    await f.manager.send(active.id, { text: 'active work' })
    await f.started.promise
    assert.deepEqual(await f.manager.restoreCheckpoint(target.id, turn.id), { files: 0, error: null })
    assert.equal(restoreCalls, 1)
  })
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

test('restore fences sends and other restores in an overlapping workspace', async (t) => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture(t, { checkpointsEnabled: () => false, checkpoints: {
    async restore() { entered.resolve(); await release.promise; return { restored: ['file'], removed: [], undo: 'undo', error: null } },
    async forget() {},
  } })
  const turn = checkpointTurn(f)
  const nested = path.join(f.base, 'nested')
  await fs.mkdir(nested)
  const sibling = await f.manager.create({ workspace: nested, model: '["test","model"]' })
  const siblingTurn = checkpointTurn(f, sibling.id)
  const restoring = f.manager.restoreCheckpoint(f.thread.id, turn.id)
  await entered.promise
  assert.equal(f.manager.busy, true)
  const sending = f.manager.send(sibling.id, { text: 'must wait' }).then(
    () => ({ blocked: false }), (error) => ({ blocked: /復元中/.test(error.message) }),
  )
  const sendOutcome = await sending
  const otherRestore = f.manager.restoreCheckpoint(sibling.id, siblingTurn.id).then(
    () => ({ blocked: false }), (error) => ({ blocked: /復元中/.test(error.message) }),
  )
  release.resolve()
  assert.deepEqual({ sendOutcome, restoreOutcome: await otherRestore }, { sendOutcome: { blocked: true }, restoreOutcome: { blocked: true } })
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
  const nested = path.join(f.base, 'nested')
  await fs.mkdir(nested)
  const sibling = await f.manager.create({ workspace: nested, model: '["test","model"]' })
  const sending = f.manager.send(sibling.id, { text: 'must not run during restore' })
  const outcome = sending.then(() => ({ blocked: false }), (error) => ({ blocked: /復元中/.test(error.message) }))
  await validating.promise
  const restoration = f.manager.restoreCheckpoint(f.thread.id, turn.id)
  await restoring.promise
  accounts.resolve({})
  const sendOutcome = await outcome
  restoreResult.resolve({ restored: [], removed: [], undo: 'undo', error: null })
  await restoration
  assert.deepEqual({ sendOutcome, sessions: f.calls.sessions }, { sendOutcome: { blocked: true }, sessions: 0 })
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
