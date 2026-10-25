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
