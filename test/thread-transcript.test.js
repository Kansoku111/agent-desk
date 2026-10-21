import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadMarkdown } from '../web/src/thread-transcript.ts'

const turn = (overrides) => ({
  id: 't1', startedAt: 1, endedAt: 2, status: 'done', stopReason: null, error: null,
  user: { text: '直して', images: [] }, items: [], ...overrides,
})

test('keeps messages and replies, shrinks tools to one line, drops thinking', () => {
  const text = threadMarkdown({ title: 'バグ修正', workspace: 'F:\\app', model: 'claude / opus' }, [turn({
    items: [
      { type: 'thought', id: 'a', text: '秘密の考え' },
      { type: 'tool', id: 'b', name: 'Bash', kind: 'execute', status: 'completed', input: { command: 'npm test\nmore' }, output: 'long output' },
      { type: 'tool', id: 'c', name: 'Edit', kind: 'edit', status: 'failed', input: { file_path: 'a.ts' } },
      { type: 'agent', id: 'd', text: '直しました。' },
    ],
  })])
  assert.equal(text, [
    '# バグ修正', '', '- 作業フォルダ: F:\\app', '- モデル: claude / opus',
    '', '## ユーザー', '', '直して',
    '', '## エージェント', '', '- Bash: `npm test`', '- Edit: `a.ts`（失敗）', '', '直しました。', '',
  ].join('\n'))
})

test('keeps the start of a failed tool output in a fence it cannot close', () => {
  const output = ['```', ...Array.from({ length: 24 }, (_, index) => `line ${index + 1}`)].join('\n')
  const text = threadMarkdown({ title: 'x', workspace: 'w', model: null }, [turn({
    items: [{ type: 'tool', id: 'b', name: 'Bash', kind: 'execute', status: 'failed', input: { command: 'npm test' }, output }],
  })])
  assert.match(text, /- Bash: `npm test`（失敗）\n  ````\n  ```\n  line 1\n/)
  assert.match(text, / {2}line 19\n {2}…（残り 5 行を省略）\n {2}````\n/)
  assert.doesNotMatch(text, /line 20/)
})

test('marks steering, images, cancellation and errors', () => {
  const text = threadMarkdown({ title: 'x', workspace: 'w', model: null }, [turn({
    status: 'cancelled',
    error: { message: 'boom' },
    user: { text: '', images: [{ file: 'f', mimeType: 'image/png', name: 'p' }] },
    items: [{ type: 'steer', id: 's', text: 'やっぱり\n別の案', images: [], at: 1 }],
  })])
  assert.match(text, /（テキストなし）\n\n（画像 1 枚を添付）/)
  assert.match(text, /> （作業中のユーザーの追加指示）やっぱり\n> 別の案/)
  assert.match(text, /（ユーザーが中断）\n\n（エラー）boom\n$/)
  assert.doesNotMatch(text, /モデル/)
})
