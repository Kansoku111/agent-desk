import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupRows, visibleRows } from '../web/src/task-rows.ts'
import { notificationRoute, notificationText } from '../web/src/notification.ts'

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
