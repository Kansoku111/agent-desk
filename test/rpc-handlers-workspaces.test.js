import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createWorkspaceHandlers } from '../server/rpc-handlers-workspaces.js'
import { createSettingsService } from '../server/settings.js'

function setup() {
  let settings = { workspaces: [], projectNames: {}, projectColors: {}, lastWorkspace: null }
  const service = createSettingsService({
    getSettings: () => settings,
    saveSettings: async candidate => candidate,
    publishSettings: saved => { settings = saved },
  })
  const handlers = createWorkspaceHandlers({
    paths: { myPc: '__my_pc__' },
    getSettings: () => settings,
    mutateSettings: (...args) => service.mutate(...args),
  })
  return { get settings() { return settings }, handlers }
}

test('workspace.open rejects the removed Explorer action', async () => {
  const { handlers } = setup()
  await assert.rejects(handlers['workspace.open']({ path: os.tmpdir(), target: 'files' }), /この環境では開けません/)
})

test('workspace.add refuses an empty path instead of adding the server folder', async () => {
  const h = setup()
  const { handlers } = h
  for (const args of [{ path: '' }, { path: '   ' }, { path: '""' }, {}]) {
    await assert.rejects(handlers['workspace.add'](args), /フォルダを指定してください/)
  }
  assert.deepEqual(h.settings.workspaces, [])
})

test('workspace.add still adds a folder given in quotes', async () => {
  const h = setup()
  const { handlers } = h
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-workspace-'))
  try {
    const result = await handlers['workspace.add']({ path: `"${dir}"` })
    assert.equal(result.path, path.resolve(dir))
    assert.deepEqual(h.settings.workspaces, [path.resolve(dir)])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('hiding a project keeps its files and metadata and re-adding restores it', async () => {
  const h = setup()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-hidden-project-'))
  const file = path.join(dir, 'keep.txt')
  try {
    await fs.writeFile(file, 'keep')
    await h.handlers['project.create']({ path: dir, name: 'Custom name' })
    await h.handlers['project.color']({ path: dir, color: 3 })
    await h.handlers['project.hide']({ path: dir })
    await h.handlers['project.hide']({ path: dir })
    assert.deepEqual(h.settings.workspaces, [])
    assert.deepEqual(h.settings.hiddenProjects, [dir])
    assert.equal(h.settings.lastWorkspace, null)
    assert.equal(h.settings.projectNames[dir], 'Custom name')
    assert.equal(h.settings.projectColors[dir], 3)
    assert.equal(await fs.readFile(file, 'utf8'), 'keep')
    await h.handlers['workspace.add']({ path: dir })
    assert.deepEqual(h.settings.hiddenProjects, [])
    assert.deepEqual(h.settings.workspaces, [dir])
    assert.equal(h.settings.projectNames[dir], 'Custom name')
    assert.equal(h.settings.projectColors[dir], 3)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('project hiding rejects invalid paths and My PC', async () => {
  const h = setup()
  for (const dir of [undefined, '', '  ', 42, '__my_pc__']) {
    await assert.rejects(h.handlers['project.hide']({ path: dir }), /プロジェクトが見つかりません/)
  }
  assert.equal(h.settings.hiddenProjects, undefined)
})
