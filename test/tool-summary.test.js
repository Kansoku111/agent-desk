import assert from 'node:assert/strict'
import test from 'node:test'
import { fileChanges, summarizeTool } from '../web/src/util.ts'

function tool(name, status, input, output = '') {
  return { type: 'tool', id: 'test', name, kind: 'other', status, input, output }
}

test('failed edit variants show the error instead of an unapplied diff', () => {
  for (const name of ['edit', 'str_replace_editor', 'multi_edit']) {
    const summary = summarizeTool(tool(name, 'failed', {
      file_path: 'src/example.ts', old_string: 'old', new_string: 'new',
    }, 'Error: old_string was not found'))
    assert.equal(summary.target, 'src/example.ts')
    assert.deepEqual(summary.detail, { kind: 'code', text: 'Error: old_string was not found' })
    assert.equal(summary.added, undefined)
    assert.equal(summary.removed, undefined)
  }
})

test('failed write shows the error instead of unapplied content', () => {
  const summary = summarizeTool(tool('write', 'failed', { file_path: 'new.ts', content: 'new content' }, 'Error: access denied'))
  assert.deepEqual(summary.detail, { kind: 'code', text: 'Error: access denied' })
  assert.equal(summary.added, undefined)
  assert.equal(summary.removed, undefined)
})

test('failed file changes without output do not show an unapplied diff or counts', () => {
  for (const [name, input] of [
    ['edit', { old_string: 'old', new_string: 'new' }],
    ['write', { content: 'new' }],
  ]) {
    const summary = summarizeTool(tool(name, 'failed', input))
    assert.equal(summary.detail, null)
    assert.equal(summary.added, undefined)
    assert.equal(summary.removed, undefined)
  }
})

test('Codex patches display and aggregate every file without treating failures as applied', () => {
  const changes = [
    { path: 'src/a.js', kind: { type: 'update', move_path: null }, diff: '--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+extra' },
    { path: 'src/b.js', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+created' },
  ]
  const output = changes.map(change => `${change.path}\n${change.diff}`).join('\n\n')
  const completed = tool('edit', 'completed', { path: 'src/a.js', changes }, output)
  const summary = summarizeTool(completed)
  assert.deepEqual(summary.detail, { kind: 'code', text: output })
  assert.deepEqual([summary.added, summary.removed], [3, 1])
  assert.deepEqual(fileChanges({ items: [completed] }), [
    { path: 'src/a.js', added: 2, removed: 1, created: false },
    { path: 'src/b.js', added: 1, removed: 0, created: true },
  ])
  const failed = tool('edit', 'failed', { changes }, output)
  assert.equal(summarizeTool(failed).detail.text, output)
  assert.equal(summarizeTool(failed).added, undefined)
  assert.deepEqual(fileChanges({ items: [failed] }), [])
})

test('completed edits and writes retain their existing diff and counts', () => {
  const edit = summarizeTool(tool('edit', 'completed', { old_string: 'old', new_string: 'new' }))
  assert.equal(edit.detail.kind, 'diff')
  assert.deepEqual([edit.added, edit.removed], [1, 1])
  const write = summarizeTool(tool('write', 'completed', { content: 'new\ncontent' }))
  assert.equal(write.detail.kind, 'diff')
  assert.deepEqual([write.added, write.removed], [2, 0])
})
