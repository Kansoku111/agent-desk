import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexRunner } from '../server/codex-runner.js'
import { withSpeed } from '../web/src/turn-updates.ts'

class FakeServer extends EventEmitter {
  constructor() { super(); this.thread = 0; this.turn = 0 }
  async use(work) { return work() }
  async rawRequest(method, params) {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'speed@example.test' } }
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++this.thread } }
    if (method === 'thread/resume') return { thread: { id: params.threadId } }
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.turn } }
    return {}
  }
  respond() {}
  reject() {}
  async stop() { this.emit('stopped', new Error('stopped')) }
}
const text = 'a'.repeat(224) // 56 estimated tokens, not a provider tokenizer count.

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-speed-'))
  const server = new FakeServer()
  let now = 0
  const runner = await new CodexRunner({ home, attachmentsDir: home, server, speedNow: () => now }).load()
  const speedFrames = [], turns = []
  runner.on('turn-speed', frame => speedFrames.push(frame))
  runner.on('turn', frame => turns.push(frame))
  t.after(async () => { await runner.shutdown(); await fs.rm(home, { recursive: true, force: true }) })
  const task = await runner.create({ workspace: home })
  runner.run(task.id, 'test')
  const turnId = await runner.waitForStart(task.id)
  const ids = { threadId: runner.get(task.id).sessionId, turnId }
  const live = runner.live.get(task.id)
  const event = (method, params = {}) => server.emit('notification', method, { ...ids, ...params })
  const begin = id => event('item/started', { item: { id, type: 'agentMessage', text: '' } })
  const delta = (id, value = text) => event('item/agentMessage/delta', { itemId: id, delta: value })
  const complete = async (items = [], status = 'completed') => {
    const done = once(runner, 'finished')
    event('turn/completed', { turn: { id: turnId, status, items } })
    await done
  }
  return { home, server, runner, task, live, ids, speedFrames, turns, event, begin, delta, complete, at: time => { now = time } }
}

test('GP emits small live speed frames and saves a final estimate for reload', async t => {
  const f = await fixture(t)
  f.begin('answer'); f.delta('answer')
  f.at(1000); f.delta('answer'); f.live.speed.tick()
  const speed = { tokensPerSecond: 56, state: 'streaming', estimated: true }
  assert.deepEqual(f.speedFrames.at(-1), { id: f.task.id, turnId: f.live.turn.id, speed })
  const count = f.turns.length
  f.at(2000); f.live.speed.tick()
  assert.equal(f.speedFrames.at(-1).speed.tokensPerSecond, 28)
  assert.equal(f.turns.length, count, 'timer updates do not resend the transcript')
  await f.complete([{ id: 'answer', type: 'agentMessage', text: text + text }])
  const final = f.runner.turns(f.task.id)[0]
  assert.deepEqual(final.outputSpeed, { tokensPerSecond: 56, state: 'done', estimated: true })
  assert.equal(f.live.speed.timer, null)
  const reloaded = await new CodexRunner({ home: f.home, attachmentsDir: f.home, server: new FakeServer() }).load()
  t.after(() => reloaded.shutdown())
  assert.deepEqual(reloaded.turns(f.task.id)[0].outputSpeed, final.outputSpeed)
})

test('GP hides speed during tools and approvals and excludes tool output and waiting time', async t => {
  const f = await fixture(t)
  f.begin('first'); f.delta('first'); f.at(1000); f.delta('first'); f.live.speed.tick()
  f.event('item/started', { item: { id: 'command', type: 'commandExecution', command: 'test' } })
  assert.equal(f.runner.turns(f.task.id)[0].outputSpeed, undefined)
  assert.equal(f.speedFrames.at(-1).speed, null)
  assert.equal(f.live.speed.timer, null)
  f.at(60_000); f.event('item/commandExecution/outputDelta', { itemId: 'command', delta: text.repeat(1000) })
  assert.equal(f.runner.turns(f.task.id)[0].outputSpeed, undefined)
  f.begin('second'); f.delta('second'); f.at(61_000); f.delta('second'); f.live.speed.tick()
  assert.equal(f.speedFrames.at(-1).speed.tokensPerSecond, 56)
  f.server.emit('request', { id: 1, method: 'item/commandExecution/requestApproval', params: { ...f.ids, command: 'test' } })
  assert.equal(f.speedFrames.at(-1).speed, null)
  f.runner.respondPermission(f.task.id, '1', 'decline')
  f.at(120_000); f.begin('final'); f.delta('final'); f.at(121_000); f.delta('final')
  await f.complete([{ id: 'final', type: 'agentMessage', text: text + text }])
  assert.equal(f.runner.turns(f.task.id)[0].outputSpeed.tokensPerSecond, 56)
})

test('GP stop pauses immediately and ignores late deltas for its settled partial speed', async t => {
  const f = await fixture(t)
  f.begin('answer'); f.delta('answer'); f.at(1000); f.delta('answer'); f.live.speed.tick()
  const stop = f.runner.stop(f.task.id)
  assert.equal(f.live.speed.timer, null)
  f.at(60_000); f.delta('answer', text.repeat(1000))
  assert.equal(f.live.speed.state, 'paused')
  await f.complete([], 'interrupted')
  await stop
  assert.equal(f.runner.turns(f.task.id)[0].status, 'cancelled')
  assert.deepEqual(f.runner.turns(f.task.id)[0].outputSpeed, { tokensPerSecond: 56, state: 'done', estimated: true })
})

test('a snapshot-only final answer never inherits an earlier GP speed', async t => {
  const f = await fixture(t)
  f.begin('earlier'); f.delta('earlier'); f.at(1000); f.delta('earlier'); f.live.speed.tick()
  await f.complete([{ id: 'earlier', type: 'agentMessage', text: text + text }, { id: 'final', type: 'agentMessage', text: text.repeat(10) }])
  assert.equal(f.runner.turns(f.task.id)[0].outputSpeed, undefined)
})

test('an interrupted persisted turn discards an unfinished streaming speed', async t => {
  const f = await fixture(t)
  f.begin('answer'); f.delta('answer'); f.at(1000); f.delta('answer')
  await f.complete([])
  const file = path.join(f.home, 'codex-tasks', f.task.id + '.json')
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  saved.turns[0].status = 'running'
  saved.turns[0].outputSpeed = { tokensPerSecond: 56, state: 'streaming', estimated: true }
  await fs.writeFile(file, JSON.stringify(saved))
  const reloaded = await new CodexRunner({ home: f.home, attachmentsDir: f.home, server: new FakeServer() }).load()
  t.after(() => reloaded.shutdown())
  assert.equal(reloaded.turns(f.task.id)[0].status, 'cancelled')
  assert.equal(reloaded.turns(f.task.id)[0].outputSpeed, undefined)
})

test('the GP client frame updates just the target turn and preserves transcript identities', async () => {
  const speed = { tokensPerSecond: 56, state: 'streaming', estimated: true }
  const turns = [{ id: 'first', items: [] }, { id: 'target', items: [{ type: 'agent', id: 'a', text }] }]
  const next = withSpeed(turns, 'target', speed)
  assert.equal(next[0], turns[0])
  assert.equal(next[1].items, turns[1].items)
  assert.deepEqual(next[1].outputSpeed, speed)
  assert.equal(withSpeed(undefined, 'target', speed), null)
  assert.equal(withSpeed(next, 'missing', speed), null)
  assert.equal(withSpeed(next, 'target', speed), null)
  const cleared = withSpeed(next, 'target', null)
  assert.equal(cleared[1].outputSpeed, undefined)
  const store = await fs.readFile(new URL('../web/src/store.ts', import.meta.url), 'utf8')
  const index = await fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8')
  assert.match(store, /case 'codexTurnSpeed':/)
  assert.match(store, /withSpeed[(]state[.]codexTurns\[frame[.]taskId\], frame[.]turnId, frame[.]speed[)]/)
  assert.match(index, /codex[.]on[(]'turn-speed'/)
  assert.match(index, /broadcast[(]'codexTurnSpeed'/)
})
