import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ClaudeRunner } from '../server/claude-runner.js'

test('Claude observer can change next model without changing its session', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observer-claude-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const runner = await new ClaudeRunner({ dir }).load()
  const first = await runner.create({ workspace: dir, model: 'haiku', effort: 'low' })
  await runner.configure(first.id, { model: 'sonnet', effort: 'high' })
  const updated = runner.get(first.id)
  assert.equal(updated.sessionId, first.sessionId)
  assert.equal(updated.model, 'sonnet')
  assert.equal(updated.effort, 'high')
  const again = await new ClaudeRunner({ dir }).load()
  assert.equal(again.get(first.id).model, 'sonnet')
  runner.live.set(first.id, {})
  await assert.rejects(runner.configure(first.id, { model: 'haiku', effort: 'low' }), /作業中/)
  runner.live.delete(first.id)
})
