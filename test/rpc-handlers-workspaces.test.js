import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createWorkspaceHandlers } from '../server/rpc-handlers-workspaces.js'

function setup() {
  const settings = { workspaces: [], projectNames: {}, projectColors: {}, lastWorkspace: null }
  const handlers = createWorkspaceHandlers({
    paths: { myPc: '__my_pc__' },
    getSettings: () => settings,
    saveSettings: async () => {},
    broadcast: () => {},
  })
  return { settings, handlers }
}

test('workspace.add refuses an empty path instead of adding the server folder', async () => {
  const { settings, handlers } = setup()
  for (const args of [{ path: '' }, { path: '   ' }, { path: '""' }, {}]) {
    await assert.rejects(handlers['workspace.add'](args), /フォルダを指定してください/)
  }
  assert.deepEqual(settings.workspaces, [])
})

test('workspace.add still adds a folder given in quotes', async () => {
  const { settings, handlers } = setup()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-workspace-'))
  try {
    const result = await handlers['workspace.add']({ path: `"${dir}"` })
    assert.equal(result.path, path.resolve(dir))
    assert.deepEqual(settings.workspaces, [path.resolve(dir)])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
