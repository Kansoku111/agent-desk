import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ExecutionVerifier } from '../server/execution.js'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'

test('EX model RPC persists without creating a team or changing TM settings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ex-models-'))
  const execution = await new ExecutionVerifier({ dir }).load()
  t.after(async () => { await execution.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  const handlers = createTerminalHandlers({ teams: { execution, create() { throw new Error('must not start a team') } } })
  assert.deepEqual(await handlers['execution.models'](), { models: null })
  const models = { leader: 'claude:sonnet', provider: 'claude', model: 'sonnet', leaderEffort: 'high', childEffort: 'medium' }
  assert.deepEqual(await handlers['execution.setModels']({ models }), { models })
  // A new handler/browser has no browser-local state; the server owns the choice.
  assert.deepEqual(await handlers['execution.models'](), { models })
  assert.deepEqual(await handlers['execution.setModels']({ models: { ...models, leader: 'claude:opus' }, onlyIfUnset: true }), { models })
  const restored = await new ExecutionVerifier({ dir }).load()
  assert.deepEqual(await restored.modelSelection(), models)
})
