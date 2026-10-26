import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodeFrames, foldChild, LogTail, newChild, SubagentTracker } from '../server/subagents.js'

/** One zstd frame holding the events as JSON lines, like one dsh write batch. */
const frame = (...events) => zlib.zstdCompressSync(Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join('')))
const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1000, cwd: 'C:\\work', ...extra })
let seq = 0
const event = (type, data, time = 1000 + seq) => ({ type, seq: seq++, time, data })

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-subagents-'))
}

test('decodeFrames reads whole frames and stops before one still being written', async () => {
  const first = frame({ type: 'a', seq: 0 }, { type: 'b', seq: 1 })
  const second = frame({ type: 'c', seq: 2 })
  const whole = await decodeFrames(Buffer.concat([first, second]))
  assert.deepEqual(whole.events.map((entry) => entry.type), ['a', 'b', 'c'])
  // The last frame is read again next time, as it may still grow.
  assert.equal(whole.consumed, first.length)

  const cut = await decodeFrames(Buffer.concat([first, second.subarray(0, second.length - 3)]))
  assert.deepEqual(cut.events.map((entry) => entry.type), ['a', 'b'])
  assert.equal(cut.consumed, first.length)
})

test('decodeFrames skips a corrupt piece rather than stalling on it', async () => {
  const first = frame({ type: 'a', seq: 0 })
  // A magic number planted inside a frame breaks it into pieces that never decode.
  const corrupt = Buffer.concat([first.subarray(0, 6), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), first.subarray(6)])
  const later = ['b', 'c', 'd', 'e', 'f'].map((type, index) => frame({ type, seq: index + 1 }))
  const result = await decodeFrames(Buffer.concat([corrupt, ...later]))
  assert.deepEqual(result.events.map((entry) => entry.type), ['b', 'c', 'd', 'e', 'f'])
})

test('LogTail returns each event once as the log grows', async () => {
  const dir = await tempHome()
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const tail = new LogTail(file)
  assert.deepEqual(await tail.read(), [])
  await fs.writeFile(file, frame(header('s1'), { type: 'turn/start', seq: 0, time: 1 }))
  assert.deepEqual((await tail.read()).map((entry) => entry.type), ['turn/start'])
  assert.equal(tail.header.id, 's1')
  assert.deepEqual(await tail.read(), [])
  await fs.appendFile(file, frame({ type: 'tool/call', seq: 1, time: 2 }))
  await fs.appendFile(file, frame({ type: 'turn/end', seq: 2, time: 3 }))
  assert.deepEqual((await tail.read()).map((entry) => entry.type), ['tool/call', 'turn/end'])
  assert.deepEqual(await tail.read(), [])
  await fs.rm(dir, { recursive: true, force: true })
})

test('LogTail rereads a same-size replaced log', async (t) => {
  const dir = await tempHome()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const tail = new LogTail(file)
  const first = frame({ type: 'one', seq: 0, time: 1 })
  const second = frame({ type: 'two', seq: 0, time: 1 })
  assert.equal(first.length, second.length)

  await fs.writeFile(file, first)
  assert.deepEqual((await tail.read()).map((entry) => entry.type), ['one'])
  const previous = await fs.stat(file)
  await fs.writeFile(file, second)
  await fs.utimes(file, new Date(previous.atimeMs), new Date(previous.mtimeMs + 2000))
  assert.deepEqual((await tail.read()).map((entry) => entry.type), ['two'])
})

test('LogTail with a line filter parses only the lines asked for and still returns each event once', async () => {
  const dir = await tempHome()
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const tail = new LogTail(file, { keep: (line) => line.includes('tool/call') || line.includes('"session"') })
  await fs.writeFile(file, Buffer.concat([frame(header('s1')), frame({ type: 'turn/start', seq: 0, time: 1 }, { type: 'tool/call', seq: 1, time: 2 })]))
  assert.deepEqual((await tail.read()).map((entry) => entry.type), ['tool/call'])
  assert.equal(tail.header.id, 's1')
  await fs.appendFile(file, frame({ type: 'tool/result', seq: 2, time: 3 }, { type: 'tool/call', seq: 3, time: 4 }))
  await fs.appendFile(file, frame({ type: 'turn/end', seq: 4, time: 5 }))
  assert.deepEqual((await tail.read()).map((entry) => entry.seq), [3])
  assert.deepEqual(await tail.read(), [])
  // Many frames, as a long task writes, come back whole and in order.
  const many = []
  for (let seq = 5; seq < 105; seq += 1) many.push(frame({ type: seq % 2 ? 'tool/call' : 'step/start', seq, time: seq }))
  await fs.appendFile(file, Buffer.concat(many))
  assert.deepEqual((await tail.read()).map((entry) => entry.seq), Array.from({ length: 50 }, (_, index) => 5 + index * 2))
  await fs.rm(dir, { recursive: true, force: true })
})

test('foldChild turns a child log into the items a turn shows', () => {
  const child = newChild(header('c1', { parentSession: 'p1', delegationDepth: 1 }))
  const events = [
    event('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn', label: 'Review the diff', agentProvider: 'anthropic', agentModel: 'claude-opus-5-5', agentReasoningEffort: 'high' }),
    event('user/message', { content: [{ type: 'text', text: 'Review it.' }, { type: 'text', text: 'Your parent agent id is "p1". Before you finish…' }], source: { kind: 'user' }, id: 'u1' }),
    event('user/message', { content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context' } }),
    event('turn/start', { turn: 1 }),
    event('assistant/message', {
      message: { id: 'm1', content: [{ type: 'reasoning', text: 'Look first' }, { type: 'reasoning', text: '' }, { type: 'reasoning', text: 'then read' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }], source: { provider: 'anthropic', model: 'claude-opus-5-5' } },
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
    event('tool/call', { callId: 'call-1', name: 'read', arguments: '{"file_path":"a.ts"}' }),
    event('tool/result', { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'file text' }], isError: false } }),
    event('user/message', { content: [{ type: 'text', text: 'Agent p1 sent a message: ' }, { type: 'text', text: 'Also check b.ts' }], source: { kind: 'agent-message', form: 'relay' }, id: 'u2' }),
    event('assistant/message', { message: { id: 'm2', content: [{ type: 'text', text: 'Looks good.' }] } }),
  ]
  assert.equal(child.status, 'starting')
  for (const entry of events) foldChild(child, entry, new Map([['anthropic/claude-opus-5-5', { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 }]]))
  assert.equal(child.status, 'running')
  assert.equal(child.label, 'Review the diff')
  assert.equal(child.model, 'claude-opus-5-5')
  assert.equal(child.effort, 'high')
  assert.equal(child.prompt, 'Review it.')
  assert.deepEqual(child.items.map((item) => item.type), ['thought', 'tool', 'steer', 'agent'])
  assert.equal(child.items[0].text, 'Look first\n\nthen read')
  assert.deepEqual(child.items[1], { type: 'tool', id: 'call-1', name: 'read', kind: 'other', status: 'completed', input: { file_path: 'a.ts' }, output: 'file text', startedAt: events[5].time, endedAt: events[6].time })
  assert.equal(child.items[2].text, 'Also check b.ts')
  assert.equal(child.items[2].from, 'agent')
  assert.equal(child.usage.input, 100)
  assert.equal(Number(child.usage.cost.toFixed(6)), (100 * 5 + 20 * 25) / 1e6)

  foldChild(child, event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'no such model' } } }))
  assert.equal(child.status, 'error')
  assert.match(child.items.at(-1).text, /no such model/)
})

test('foldChild skips the history a fork was seeded with', () => {
  const child = newChild(header('c2', { parentSession: 'p1', isSeeded: true }))
  foldChild(child, event('assistant/message', { message: { id: 'old', content: [{ type: 'text', text: 'parent history' }] } }))
  foldChild(child, event('request/header', { header: { config: { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' } } }))
  foldChild(child, event('session/end-seed', {}))
  foldChild(child, event('assistant/message', { message: { id: 'new', content: [{ type: 'text', text: 'own work' }] } }))
  assert.deepEqual(child.items.map((item) => item.text), ['own work'])
  assert.equal(child.model, 'gpt-6.1-sol')
})

test('SubagentTracker evicts expired idle trees when polling stops', async (t) => {
  const tracker = new SubagentTracker({ dshHome: 'unused', pollMs: 10 })
  t.after(() => tracker.stop())
  tracker.follow('old-thread', 'session', false)
  tracker.trees.get('old-thread').usedAt = 0

  for (let waited = 0; tracker.timer && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(tracker.trees.has('old-thread'), false)
  assert.equal(tracker.timer, null)
})

for (const ptc of [false, true]) test(`SubagentTracker finds children and links ${ptc ? 'PTC internal' : 'native'} calls`, async () => {
  const home = await tempHome()
  const folder = path.join(home, 'sessions', '--C-work--')
  const log = (id) => path.join(folder, id, 'session.v4.jsonl.zstd')
  for (const id of ['parent', 'child-a', 'child-b', 'grandchild']) await fs.mkdir(path.join(folder, id), { recursive: true })
  await fs.writeFile(log('parent'), frame(
    header('parent'),
    { type: ptc ? 'tool/ptc-dispatch-start' : 'tool/call', seq: 0, time: 1, data: { ...(ptc ? { subCallId: 'call-a', parentCallId: 'root', rootCallId: 'root' } : { callId: 'call-a' }), name: 'subagent_claude', arguments: '{"description":"First"}' } },
    { type: ptc ? 'tool/ptc-dispatch-start' : 'tool/call', seq: 1, time: 1, data: { ...(ptc ? { subCallId: 'call-b', parentCallId: 'root', rootCallId: 'root' } : { callId: 'call-b' }), name: 'subagent', arguments: '{"description":"Second"}' } },
    // Catalog order need not follow call order; labels decide.
    { type: 'subagent/catalog', seq: 2, time: 2, data: { childId: 'child-b', childCreatedAt: 2, mode: 'one-shot', label: 'Second' } },
    { type: 'subagent/catalog', seq: 3, time: 2, data: { childId: 'child-a', childCreatedAt: 2, mode: 'one-shot', label: 'First' } },
  ))
  await fs.writeFile(log('child-a'), frame(
    header('child-a', { parentSession: 'parent', delegationDepth: 1 }),
    { type: 'subagent/descriptor', seq: 0, time: 3, data: { mode: 'one-shot', label: 'First', agentProvider: 'anthropic', agentModel: 'claude-opus-5-5' } },
    { type: 'turn/start', seq: 1, time: 3, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 4, data: { callId: 'call-g', name: 'subagent', arguments: '{"description":"Deeper"}' } },
    { type: 'subagent/catalog', seq: 3, time: 4, data: { childId: 'grandchild', childCreatedAt: 4, mode: 'one-shot', label: 'Deeper' } },
  ))
  await fs.writeFile(log('child-b'), frame(header('child-b', { parentSession: 'parent' }), { type: 'turn/start', seq: 0, time: 3, data: { turn: 1 } }, { type: 'turn/end', seq: 1, time: 5, data: { reason: { kind: 'completed' } } }))
  await fs.writeFile(log('grandchild'), frame(header('grandchild', { parentSession: 'child-a', delegationDepth: 2 }), { type: 'turn/start', seq: 0, time: 5, data: { turn: 1 } }))

  let live = true
  const tracker = new SubagentTracker({ dshHome: home, modelName: (_provider, id) => (id === 'claude-opus-5-5' ? 'Opus 5.5' : null), isLive: () => live, pollMs: 20 })
  const list = await tracker.list('thread-1', 'parent')
  const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]))
  assert.deepEqual(Object.keys(byId).sort(), ['child-a', 'child-b', 'grandchild'])
  assert.equal(byId['child-a'].callId, 'call-a')
  assert.equal(byId['child-a'].modelName, 'Opus 5.5')
  assert.equal(byId['child-a'].status, 'running')
  assert.equal(byId['child-b'].callId, 'call-b')
  assert.equal(byId['child-b'].status, 'done')
  assert.equal(byId.grandchild.parentId, 'child-a')
  assert.equal(byId.grandchild.depth, 2)
  assert.equal(byId.grandchild.callId, 'call-g')

  const changes = []
  tracker.on('change', (change) => changes.push(change))
  tracker.follow('thread-1', 'parent', true)
  await fs.appendFile(log('child-a'), frame({ type: 'assistant/message', seq: 4, time: 6, data: { message: { id: 'm', content: [{ type: 'text', text: 'done' }] } } }))
  for (let waited = 0; !changes.length && waited < 2000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
  tracker.stop()
  assert.equal(changes[0].threadId, 'thread-1')
  assert.equal(changes[0].subagent.id, 'child-a')
  assert.equal(changes[0].subagent.items.at(-1).text, 'done')

  // A child still "running" once its runtime is gone was cut off.
  live = false
  const after = await tracker.list('thread-1', 'parent')
  assert.equal(after.find((entry) => entry.id === 'grandchild').status, 'stopped')
  await fs.rm(home, { recursive: true, force: true })
})
