import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSettingsService, DEFAULT_SETTINGS } from '../server/settings.js'
import { createWorkspaceHandlers } from '../server/rpc-handlers-workspaces.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function setup(save = async candidate => candidate) {
  let live = structuredClone(DEFAULT_SETTINGS)
  const notices = []
  const service = createSettingsService({
    getSettings: () => live,
    saveSettings: save,
    publishSettings: saved => { live = saved; notices.push(saved) },
  })
  const handlers = createWorkspaceHandlers({
    paths: { myPc: '__my_pc__' }, getSettings: () => live,
    mutateSettings: (...args) => service.mutate(...args),
  })
  return { service, handlers, notices, get live() { return live } }
}

test('project rename save failure preserves the public snapshot and sends no success notice', async () => {
  const h = setup(async () => { throw new Error('disk full') })
  const before = structuredClone(h.live)
  await assert.rejects(h.handlers['project.rename']({ path: 'project', name: 'New name' }), /disk full/)
  assert.deepEqual(h.live, before)
  assert.deepEqual(h.notices, [])
})

test('internal candidate is deeply isolated even when validation or persistence fails', async () => {
  let writes = 0
  const h = setup(async () => { writes++; throw new Error('disk full') })
  const before = structuredClone(h.live)
  await assert.rejects(h.service.mutate(candidate => {
    candidate.agentTeams.extra = { nested: true }
    candidate.workspaces.push('new')
    throw new Error('invalid candidate')
  }), /invalid candidate/)
  assert.equal(writes, 0)
  assert.deepEqual(h.live, before)
  await assert.rejects(h.service.mutate(candidate => {
    candidate.agentTeams.extra = { nested: true }
    candidate.workspaces.push('new')
  }), /disk full/)
  assert.deepEqual(h.live, before)
  assert.deepEqual(h.notices, [])
})

test('workspace mutation and RPC patch share one queue and use the latest committed snapshot', async () => {
  const started = deferred()
  const finish = deferred()
  let writes = 0
  const h = setup(async candidate => {
    if (++writes === 1) { started.resolve(); await finish.promise }
    return candidate
  })
  const first = h.service.update({ theme: 'light' })
  await started.promise
  const rename = h.handlers['project.rename']({ path: 'project', name: 'Name' })
  const color = h.handlers['project.color']({ path: 'project', color: 2 })
  assert.equal(h.live.theme, 'dark')
  assert.deepEqual(h.live.projectNames, {})
  assert.equal(writes, 1)
  finish.resolve()
  await Promise.all([first, rename, color])
  assert.equal(h.live.theme, 'light')
  assert.equal(h.live.projectNames.project, 'Name')
  assert.equal(h.live.projectColors.project, 2)
  assert.equal(h.notices.length, 3)
})

test('failed internal save does not drop an already queued update', async () => {
  let writes = 0
  const h = setup(async candidate => {
    if (++writes === 1) throw new Error('disk full')
    return candidate
  })
  const failed = h.handlers['project.rename']({ path: 'project', name: 'Unsaved' })
  const next = h.service.update({ theme: 'light' })
  await assert.rejects(failed, /disk full/)
  await next
  assert.deepEqual(h.live.projectNames, {})
  assert.equal(h.live.theme, 'light')
  assert.equal(h.notices.length, 1)
})

test('post-commit failure is explicitly distinguished and never rolls back the commit', async () => {
  const h = setup()
  await assert.rejects(h.service.mutate(candidate => { candidate.remoteAccess = true }, {
    afterCommit: () => { throw new Error('listener unavailable') },
  }), error => {
    assert.equal(error.settingsCommitted, true)
    assert.match(error.message, /保存済み/)
    assert.match(error.cause.message, /listener unavailable/)
    return true
  })
  assert.equal(h.live.remoteAccess, true)
  await h.service.update({ theme: 'light' })
  assert.equal(h.live.remoteAccess, true)
})

test('settings.update runtime effect errors also identify the successful commit', async () => {
  let live = structuredClone(DEFAULT_SETTINGS)
  const service = createSettingsService({
    getSettings: () => live, saveSettings: async candidate => candidate,
    publishSettings: saved => { live = saved },
    applyHomePatch: () => { throw new Error('patch unavailable') },
  })
  await assert.rejects(service.update({ customInstructions: 'saved' }), error => {
    assert.equal(error.settingsCommitted, true)
    assert.match(error.message, /保存済み/)
    return true
  })
  assert.equal(live.customInstructions, 'saved')
})
/* Post-save errors must not be confused with failed persistence, including notices. */
test('publication notice failure retains the installed saved snapshot', async () => {
  let live = structuredClone(DEFAULT_SETTINGS)
  const service = createSettingsService({
    getSettings: () => live, saveSettings: async candidate => candidate,
    publishSettings: saved => { live = saved; throw new Error('notice failed') },
  })
  await assert.rejects(service.update({ theme: 'light' }), error => error.settingsCommitted === true)
  assert.equal(live.theme, 'light')
})

test('invalid project color does not persist, publish or notify', async () => {
  let writes = 0
  const h = setup(async candidate => { writes++; return candidate })
  await assert.rejects(h.handlers['project.color']({ path: 'project', color: 'invalid' }), /色/)
  assert.equal(writes, 0)
  assert.deepEqual(h.notices, [])
})
test('deep candidate changes remain private while persistence is blocked', async () => {
  const started = deferred()
  const finish = deferred()
  const h = setup(async candidate => { started.resolve(); await finish.promise; return candidate })
  const update = h.service.mutate(candidate => { candidate.agentTeams.extra = ['new'] })
  await started.promise
  assert.equal(h.live.agentTeams.extra, undefined)
  assert.equal(h.notices.length, 0)
  finish.resolve()
  await update
  assert.deepEqual(h.live.agentTeams.extra, ['new'])
  assert.equal(h.notices.length, 1)
})
