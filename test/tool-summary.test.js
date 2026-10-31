import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeTool } from '../web/src/util.ts'

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

test('completed edits and writes retain their existing diff and counts', () => {
  const edit = summarizeTool(tool('edit', 'completed', { old_string: 'old', new_string: 'new' }))
  assert.equal(edit.detail.kind, 'diff')
  assert.deepEqual([edit.added, edit.removed], [1, 1])
  const write = summarizeTool(tool('write', 'completed', { content: 'new\ncontent' }))
  assert.equal(write.detail.kind, 'diff')
  assert.deepEqual([write.added, write.removed], [2, 0])
})
