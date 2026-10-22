import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ClaudeConversation, ClaudeTranscripts, MAX_TURNS, userText } from '../server/claude-transcript.js'

const stamp = (n) => new Date(Date.UTC(2026, 9, 20, 0, 0, n)).toISOString()
const user = (uuid, content, n, extra = {}) => ({ parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp: stamp(n), message: { role: 'user', content }, ...extra })
const assistant = (uuid, content, n, extra = {}) => ({ parentUuid: null, isSidechain: false, type: 'assistant', uuid, timestamp: stamp(n), message: { role: 'assistant', content }, ...extra })
const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`

function conversationOf(entries) {
  const conversation = new ClaudeConversation()
  for (const entry of entries) conversation.add(entry)
  return conversation
}

test('a prompt, a tool call with its result, and the answer make one turn', () => {
  const conversation = conversationOf([
    user('u1', 'ファイルを読んで', 1),
    assistant('a1', [{ type: 'text', text: '読みます。' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }], 2),
    user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: '中身', is_error: false }], 3),
    assistant('a2', [{ type: 'text', text: '読みました。' }], 4),
    { type: 'system', subtype: 'turn_duration', timestamp: stamp(5), uuid: 's1' },
  ])
  assert.equal(conversation.turns.length, 1)
  const [turn] = conversation.turns
  assert.equal(turn.user.text, 'ファイルを読んで')
  assert.equal(turn.status, 'done')
  assert.equal(turn.endedAt, Date.parse(stamp(5)))
  assert.deepEqual(turn.items.map((item) => item.type), ['agent', 'tool', 'agent'])
  assert.equal(turn.items[1].status, 'completed')
  assert.equal(turn.items[1].output, '中身')
  assert.deepEqual(turn.items[1].input, { file_path: 'a.md' })
})

test('a turn is running until it finishes, and a failed tool is marked failed', () => {
  const conversation = conversationOf([
    user('u1', 'やって', 1),
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }], 2),
  ])
  assert.equal(conversation.turns[0].status, 'running')
  assert.equal(conversation.turns[0].items[0].status, 'in_progress')
  conversation.add(user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'エラー' }], is_error: true }], 3))
  assert.equal(conversation.turns[0].items[0].status, 'failed')
  assert.equal(conversation.turns[0].items[0].output, 'エラー')
})

test('the next prompt ends the turn before it, and an interrupt marks it stopped', () => {
  const conversation = conversationOf([
    user('u1', '一つ目', 1),
    assistant('a1', [{ type: 'text', text: '途中' }], 2),
    user('u2', '二つ目', 3),
    user('u3', [{ type: 'text', text: '[Request interrupted by user]' }], 4),
  ])
  assert.deepEqual(conversation.turns.map((turn) => turn.status), ['done', 'cancelled'])
  assert.equal(conversation.turns.length, 2)
})

test('meta lines, subagent lines, summaries and command output are not shown', () => {
  const conversation = conversationOf([
    user('m1', '<local-command-caveat>ignore</local-command-caveat>', 1, { isMeta: true }),
    user('c1', '<local-command-stdout>ok</local-command-stdout>', 2),
    user('s1', '要約', 3, { isCompactSummary: true }),
    user('u1', '<system-reminder>隠す</system-reminder>', 4),
    user('u2', '見せる', 5),
    assistant('a1', [{ type: 'text', text: 'サブ' }], 6, { isSidechain: true }),
    assistant('a2', [{ type: 'thinking', thinking: '', signature: 'x' }], 7),
  ])
  assert.equal(conversation.turns.length, 1)
  assert.equal(conversation.turns[0].user.text, '見せる')
  assert.equal(conversation.turns[0].items.length, 0)
})

test('a message the user typed while Claude Code worked shows in that turn; notifications and other commands do not', () => {
  const queued = (uuid, prompt, n, extra = {}) => ({
    parentUuid: null, isSidechain: false, type: 'attachment', uuid, timestamp: stamp(n),
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, ...extra },
  })
  const conversation = conversationOf([
    queued('q0', '始まる前の入力', 0),
    user('u1', '調べて', 1),
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }], 2),
    queued('q1', 'その後デプロイして', 3),
    queued('q2', '<task-notification>done</task-notification>', 4, { origin: { kind: 'task-notification' } }),
    queued('q3', 'ls', 5, { commandMode: 'bash' }),
    queued('q4', [{ type: 'text', text: '<system-reminder>x</system-reminder>' }], 6),
    user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: '中身', is_error: false }], 7),
    assistant('a2', [{ type: 'text', text: '済み' }], 8),
  ])
  const [turn] = conversation.turns
  assert.equal(conversation.turns.length, 1)
  assert.deepEqual(turn.items.map((item) => item.type), ['tool', 'steer', 'agent'])
  assert.deepEqual({ ...turn.items[1], at: undefined }, { type: 'steer', id: 'q1', text: 'その後デプロイして', images: [], at: undefined })
  assert.equal(turn.items[1].at, Date.parse(stamp(3)))
  // It is a change to the turn, so a viewer that has the turn already gets it again.
  const before = conversation.rev
  conversation.add(queued('q5', 'もう一つ', 9))
  assert.equal(conversation.rev, before + 1)
})

test('userText shows a slash command as typed and strips reminders from a prompt', () => {
  assert.equal(userText('<command-name>/model</command-name>\n <command-message>model</command-message>\n <command-args>opus</command-args>'), '/model opus')
  assert.equal(userText([{ type: 'text', text: '<system-reminder>x</system-reminder>\n質問です' }, { type: 'image', source: {} }]), '質問です\n\n[画像]')
})

test('only the latest turns are kept, and the rest are counted', () => {
  const entries = []
  for (let i = 0; i < MAX_TURNS + 5; i += 1) entries.push(user(`u${i}`, `質問${i}`, i))
  const conversation = conversationOf(entries)
  assert.equal(conversation.turns.length, MAX_TURNS)
  assert.equal(conversation.omitted, 5)
  assert.equal(conversation.turns[0].user.text, '質問5')
})

test('a read gives all the turns first, then only the ones that changed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cl-transcript-'))
  const file = path.join(dir, 'session.jsonl')
  const noise = JSON.stringify({ type: 'api-request-blob', message: { content: 'x'.repeat(2000) } })
  await fs.writeFile(file, `${noise}\n${lines([user('u1', '一つ目', 1), assistant('a1', [{ type: 'text', text: '答え' }], 2)])}`)
  const transcripts = new ClaudeTranscripts()
  const first = await transcripts.read(file)
  assert.equal(first.reset, true)
  assert.equal(first.turns.length, 1)
  assert.deepEqual(first.ids, ['u1'])

  // Nothing new: nothing sent.
  const quiet = await transcripts.read(file, { epoch: first.epoch, since: first.rev })
  assert.equal(quiet.reset, false)
  assert.equal(quiet.turns.length, 0)

  // A new prompt ends turn one and starts turn two; a half-written line waits for its end.
  const more = lines([user('u2', '二つ目', 3)])
  await fs.appendFile(file, more.slice(0, 40))
  assert.equal((await transcripts.read(file, { epoch: first.epoch, since: first.rev })).turns.length, 0)
  await fs.appendFile(file, more.slice(40))
  const next = await transcripts.read(file, { epoch: first.epoch, since: first.rev })
  assert.equal(next.reset, false)
  assert.deepEqual(next.turns.map((turn) => turn.id), ['u1', 'u2'])
  assert.equal(next.turns[0].status, 'done')
  assert.deepEqual(next.ids, ['u1', 'u2'])

  // A viewer that does not know this read (other epoch) gets everything.
  const other = await transcripts.read(file, { epoch: 'old', since: next.rev })
  assert.equal(other.reset, true)
  assert.equal(other.turns.length, 2)
  await fs.rm(dir, { recursive: true, force: true })
})
