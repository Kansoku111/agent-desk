import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './helpers/thread-manager.js'
import { beginOutputSpeed, observeOutputSpeed, finishOutputSpeed } from '../server/output-speed-bridge.js'
import { OUTPUT_SPEED_META } from '../server/output-speed.js'

const text = 'a'.repeat(100)
const chunk = (value = text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
const metric = (speed) => ({ ...chunk(''), _meta: { [OUTPUT_SPEED_META]: speed } })

/** The same stream-side meter and scalar ACP carrier the dsh hook uses. */
function stream(f) {
  const active = f.manager.active.get(f.thread.id)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  const record = {
    agent: { session: { id: sessionId } }, outputTail: Promise.resolve(),
    notify: async ({ sessionId, update }) => f.manager.onUpdate(sessionId, update),
  }
  const meter = beginOutputSpeed(record)
  let now = 0
  meter.now = () => now
  return {
    active, meter, sessionId, at: (time) => { now = time },
    text(value = text, type = 'text-delta') { observeOutputSpeed(record, { type: 'chunk', chunk: { type, text: value } }) },
    pause() { observeOutputSpeed(record, { type: 'end' }) },
    async tick() { meter.tick(); await record.outputTail },
    flush: () => record.outputTail,
    finish: () => finishOutputSpeed(record),
  }
}

for (const provider of ['openai-codex', 'anthropic', 'deepseek-official', 'opencode-go', 'local-llm']) {
  test(`${provider} receives the same live stream metadata, without billed-token calibration`, async (t) => {
    const f = await fixture(t, {
      getAccounts: async () => ({ chatgpt: { signedIn: true }, claude: { configured: true }, deepseek: { configured: true }, opencodeGo: { configured: true }, localLlm: { configured: true } }),
      getTurnUsage: async () => ({ requests: 2, input: 100, output: 100_000, reasoning: 50_000, cost: null, models: [`${provider}/test`] }),
    })
    f.manager.threads.get(f.thread.id).model = JSON.stringify([provider, 'test'])
    await f.manager.send(f.thread.id, { text: 'test' })
    await f.started.promise
    const s = stream(f)
    s.text()
    s.at(500)
    s.text(text, 'reasoning-delta')
    await s.tick()
    assert.deepEqual(s.active.turn.outputSpeed, { tokensPerSecond: 50, state: 'streaming', estimated: true })
    assert.equal(s.active.turn.items.length, 0, 'metric carriers do not append empty transcript messages')

    s.pause()
    await s.flush()
    f.manager.onUpdate(s.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'test', status: 'in_progress' })
    assert.equal(s.active.turn.outputSpeed.state, 'paused')
    assert.equal(s.meter.timer, null)
    s.at(60_000)
    f.manager.onUpdate(s.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'text', text: text.repeat(1000) }] })
    s.text()
    s.at(60_500)
    s.text()
    await s.tick()
    assert.equal(s.active.turn.outputSpeed.tokensPerSecond, 50)
    const approval = f.manager.onPermission({ sessionId: s.sessionId, toolCall: { toolCallId: 'tool-2', title: 'confirm' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] })
    assert.equal(s.active.turn.outputSpeed.state, 'paused')
    const requestId = s.active.turn.items.find((item) => item.permission).permission.requestId
    f.manager.respondPermission(requestId, 'allow')
    await approval
    await s.finish() // The hook flushes its final snapshot before the prompt response.
    f.finish.resolve()
    await s.active.done
    assert.equal(s.active.turn.outputSpeed.state, 'done')
    assert.equal(s.active.turn.outputSpeed.tokensPerSecond, 50)
    assert.equal(s.active.turn.outputSpeed.estimated, true)
    assert.equal(s.meter.timer, null)
    await f.manager.shutdown()
    const saved = (await f.disk()).turns.at(-1)
    assert.deepEqual(saved.outputSpeed, s.active.turn.outputSpeed)
    assert.equal('samples' in saved.outputSpeed, false)
    assert.equal(saved.usage.output, 100_000)
  })
}

test('cancel pauses immediately and ignores late streaming metadata', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'test' })
  await f.started.promise
  const s = stream(f)
  s.text()
  s.at(500)
  s.text()
  await s.tick()
  f.runtime.cancel = async () => { await s.finish(); f.finish.resolve() }
  const cancelling = f.manager.cancel(f.thread.id)
  assert.equal(s.active.turn.outputSpeed.state, 'paused')
  await cancelling
  await s.active.done
  assert.equal(s.active.turn.status, 'cancelled')
  assert.equal(s.active.turn.outputSpeed.state, 'done')
  assert.equal(s.meter.timer, null)
  f.manager.onUpdate(s.sessionId, metric({ tokensPerSecond: 999, state: 'streaming', estimated: true }))
  assert.equal(s.active.turn.outputSpeed.tokensPerSecond, 50)
})

test('committed ACP text is not a live stream and never acquires a fabricated speed', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'test' })
  await f.started.promise
  const active = f.manager.active.get(f.thread.id)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  for (let index = 0; index < 3; index++) f.manager.onUpdate(sessionId, chunk(text.repeat(1000)))
  f.finish.resolve()
  await active.done
  assert.equal(active.turn.outputSpeed, undefined)
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  assert.equal((await restarted.get(f.thread.id)).turns.at(-1).outputSpeed, undefined)
})

test('invalid metadata is ignored and a missing final average cannot relabel a rolling rate', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'test' })
  await f.started.promise
  const active = f.manager.active.get(f.thread.id)
  const sessionId = f.manager.threads.get(f.thread.id).sessionId
  const update = (speed) => f.manager.onUpdate(sessionId, metric(speed))
  update({ tokensPerSecond: 50, state: 'streaming', estimated: true })
  for (const speed of [{}, 5, { tokensPerSecond: -1 }, { tokensPerSecond: Infinity }, { tokensPerSecond: 1, state: 'bad', estimated: true }, { tokensPerSecond: 1, state: 'done', estimated: false }]) update(speed)
  assert.equal(active.turn.outputSpeed.tokensPerSecond, 50)
  assert.equal(active.turn.items.length, 0)
  update(null)
  assert.equal(active.turn.outputSpeed, undefined)
  update({ tokensPerSecond: 50, state: 'streaming', estimated: true })
  f.finish.resolve()
  await active.done
  assert.equal(active.turn.outputSpeed, undefined)
})
