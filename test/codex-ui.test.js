import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { groupRows, visibleRows } from '../web/src/task-rows.ts'
import { notificationRoute, notificationText } from '../web/src/notification.ts'

test('GP model frames update the shared catalog and task drafts use IME-safe keys', async () => {
  const store = await fs.readFile(new URL('../web/src/store.ts', import.meta.url), 'utf8')
  const view = await fs.readFile(new URL('../web/src/components/CodexView.tsx', import.meta.url), 'utf8')
  const app = await fs.readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
  assert.match(store, /case 'codexModels':\s*updateServer\(\{ codexModels: frame\.models \}\)/)
  assert.match(view, /const choices = initialModels \?\? \[\]/)
  assert.match(view, /useDraft\(draftKey\)/)
  assert.match(view, /getDraft\(draftKey\)/)
  assert.match(view, /ime\.confirm\(\)/)
  assert.match(app, /<CodexView key=\{route\.id\}/)
  assert.match(view, /<OpenInMenu workspace=\{task\.workspace\} task=\{!task\.team && !team && !task\.ab/)
  assert.match(view, /<TaskPresetToggle source=\{\{ kind: 'codex', id: taskId \}\}/)
  assert.match(view, /<TaskPresetRuns source=\{\{ kind: 'codex', id: taskId \}\}/)
})

test('GP tasks are mixed with other tasks, pinned first and searchable', () => {
  const group = { threads: [{ id: 'thread', updatedAt: 9 }], terminals: [], ab: [], codex: [
    { id: 'gp', updatedAt: 1, pinned: true }, { id: 'gp2', updatedAt: 5 },
  ] }
  const rows = groupRows(group)
  assert.deepEqual(rows.map((row) => row.id), ['gp', 'thread', 'gp2'])
  assert.deepEqual(visibleRows(rows, false, true, null).map((row) => row.id), ['gp', 'thread', 'gp2'])
})

test('GP notifications navigate to their Codex task', () => {
  const frame = { kind: 'codex', taskId: 'gp-1', title: 'Task', status: 'error' }
  assert.deepEqual(notificationRoute(frame), { view: 'codex', id: 'gp-1' })
  assert.match(notificationText(frame), /エラー/)
  assert.match(notificationText({ ...frame, status: 'approval' }), /承認待ち/)
  const ask = { kind: 'team-ask', threadId: 'leader', taskId: 'leader', codex: true, title: '確認' }
  assert.deepEqual(notificationRoute(ask), { view: 'codex', id: 'leader' })
  assert.match(notificationText(ask), /リーダー/)
  assert.deepEqual(notificationRoute({ ...ask, kind: 'approval-needed' }), { view: 'codex', id: 'leader' })
})
