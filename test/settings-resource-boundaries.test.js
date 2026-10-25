import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSettingsService, DEFAULT_SETTINGS } from '../server/settings.js'
import { createWorkspaceHandlers } from '../server/rpc-handlers-workspaces.js'
import { createThreadHandlers } from '../server/rpc-handlers-threads.js'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'

function setup({ fail = false, noticeFails = false } = {}) {
  let live = structuredClone(DEFAULT_SETTINGS)
  const events = []
  const service = createSettingsService({
    getSettings: () => live,
    saveSettings: async candidate => {
      events.push('save')
      if (fail) throw new Error('disk full')
      return candidate
    },
    publishSettings: (saved, { notify }) => {
      live = saved
      if (notify) {
        events.push('notice')
        if (noticeFails) throw new Error('notice unavailable')
      }
    },
  })
  return {
    get live() { return live }, events, service,
    deps: { paths: { myPc: '__my_pc__' }, getSettings: () => live, mutateSettings: (...args) => service.mutate(...args) },
  }
}

test('workspace add and project create save failure leave all settings untouched', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-project-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  for (const type of ['workspace.add', 'project.create']) {
    const h = setup({ fail: true })
    const before = structuredClone(h.live)
    const handlers = createWorkspaceHandlers(h.deps)
    await assert.rejects(handlers[type]({ path: folder, name: 'Name' }), /disk full/)
    assert.deepEqual(h.live, before)
    assert.deepEqual(h.events, ['save'])
  }
})

test('project create commits the complete project once, and removal clears its metadata', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-project-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const h = setup()
  const handlers = createWorkspaceHandlers(h.deps)
  await handlers['project.create']({ path: folder, name: ' Project name ' })
  assert.deepEqual(h.events, ['save', 'notice'])
  assert.deepEqual(h.live.workspaces, [folder])
  assert.equal(h.live.lastWorkspace, folder)
  assert.equal(h.live.projectNames[folder], 'Project name')
  await handlers['project.color']({ path: folder, color: 2 })
  await handlers['workspace.remove']({ path: folder })
  assert.deepEqual(h.live.workspaces, [])
  assert.deepEqual(h.live.projectNames, {})
  assert.deepEqual(h.live.projectColors, {})
  assert.equal(h.live.lastWorkspace, null)
  assert.deepEqual(h.events, ['save', 'notice', 'save', 'notice', 'save', 'notice'])
})

test('workspace remove failure preserves nested metadata and lastWorkspace', async () => {
  const h = setup({ fail: true })
  h.live.workspaces.push('folder')
  h.live.lastWorkspace = 'folder'
  h.live.projectNames.folder = 'Name'
  h.live.projectColors.folder = 2
  const before = structuredClone(h.live)
  await assert.rejects(createWorkspaceHandlers(h.deps)['workspace.remove']({ path: 'folder' }), /disk full/)
  assert.deepEqual(h.live, before)
  assert.deepEqual(h.events, ['save'])
})

for (const type of ['terminal.create', 'team.create']) {
  test(`${type}: resource creation order remains, failed settings save does not leak changes`, async () => {
    const h = setup({ fail: true })
    const before = structuredClone(h.live)
    const create = async () => {
      h.events.push('resource-created')
      return type === 'team.create' ? { team: { workspace: 'folder', config: { nested: { value: 1 } } } } : { workspace: 'folder' }
    }
    const handlers = createTerminalHandlers({ ...h.deps, terminals: { create }, teams: { create } })
    await assert.rejects(handlers[type]({ workspace: 'folder' }), /disk full/)
    assert.deepEqual(h.live, before)
    assert.deepEqual(h.events, ['resource-created', 'save'])
  })
}

test('team defaults do not share nested references with the created resource', async () => {
  const h = setup()
  const config = { nested: { value: 1 } }
  const result = { team: { workspace: 'folder', config } }
  const handlers = createTerminalHandlers({ ...h.deps, teams: { create: async () => result } })
  assert.strictEqual(await handlers['team.create']({}), result)
  config.nested.value = 9
  assert.equal(h.live.agentTeams.nested.value, 1)
  assert.deepEqual(h.live.workspaces, ['folder'])
  assert.deepEqual(h.events, ['save', 'notice'])
})

test('thread.update preserves no-settings-notice behavior and save failure does not leak defaults', async () => {
  for (const fail of [false, true]) {
    const h = setup({ fail })
    const before = structuredClone(h.live)
    const handlers = createThreadHandlers({ ...h.deps, threads: { update: async () => { h.events.push('thread-updated'); return { id: 'task' } } } })
    const operation = handlers['thread.update']({ threadId: 'task', model: 'new', effort: 'high', permissionMode: 'read-only' })
    if (fail) {
      await assert.rejects(operation, /disk full/)
      assert.deepEqual(h.live, before)
    } else {
      assert.deepEqual(await operation, { thread: { id: 'task' } })
      assert.equal(h.live.defaultModel, 'new')
      assert.equal(h.live.defaultEffort, 'high')
      assert.equal(h.live.defaultPermissionMode, 'read-only')
    }
    assert.deepEqual(h.events, ['thread-updated', 'save'])
  }
})

test('thread.remove post-save deletion failure is identified as committed and preserves the project', async () => {
  const h = setup()
  const handlers = createThreadHandlers({ ...h.deps, threads: {
    threads: new Map([['task', { workspace: 'folder' }]]),
    remove: async () => { throw new Error('task deletion failed') },
  } })
  await assert.rejects(handlers['thread.remove']({ threadId: 'task' }), error => {
    assert.equal(error.settingsCommitted, true)
    assert.match(error.message, /保存済み.*task deletion failed/)
    return true
  })
  assert.deepEqual(h.live.workspaces, ['folder'])
  assert.deepEqual(h.events, ['save', 'notice'])
  await h.service.update({ theme: 'light' })
  assert.equal(h.live.theme, 'light')
})

test('thread.remove waits for project preservation before deleting, and joins queued updates', async () => {
  for (const fail of [false, true]) {
    const h = setup({ fail })
    const handlers = createThreadHandlers({ ...h.deps, threads: {
      threads: new Map([['task', { workspace: 'folder' }]]),
      remove: async () => { h.events.push('remove'); return { removed: true } },
    } })
    const operation = handlers['thread.remove']({ threadId: 'task' })
    if (fail) {
      await assert.rejects(operation, /disk full/)
      assert.deepEqual(h.live.workspaces, [])
      assert.deepEqual(h.events, ['save'])
    } else {
      const next = h.service.update({ theme: 'light' })
      assert.deepEqual(await operation, { removed: true })
      await next
      assert.deepEqual(h.live.workspaces, ['folder'])
      assert.equal(h.live.theme, 'light')
      assert.ok(h.events.indexOf('remove') > h.events.indexOf('notice'))
    }
  }
})
