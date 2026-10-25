import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeConversation, MAX_TURNS } from '../server/claude-transcript.js'
import { fixture } from './helpers/thread-manager.js'

const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
const pricing = new Map([['anthropic/test-model', rates]])
const user = (id) => ({ type: 'user', uuid: `u${id}`, message: { content: `question ${id}` } })
const answer = (id, output = 100) => ({ type: 'assistant', uuid: `block-${id}`, message: {
  id: `response-${id}`, model: 'test-model', content: [{ type: 'text', text: 'answer' }],
  usage: { input_tokens: 1000, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 },
} })
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`)

test('interactive Claude records input, output, both cache kinds and deduplicates message blocks', () => {
  const c = new ClaudeConversation({ pricing })
  c.add(user(1))
  c.add(answer(1))
  c.add({ ...answer(1), uuid: 'another-block' })
  const turn = c.turns[0]
  assert.equal(turn.usage.requests, 1)
  assert.equal(turn.usage.input, 1000)
  assert.equal(turn.usage.output, 100)
  assert.equal(turn.usage.cacheRead, 1000)
  assert.equal(turn.usage.cacheWrite, 1000)
  near(turn.usage.score.points, 2.8)
  near(turn.totalScore.points, 2.8)
  // A later record with final output counts replaces the earlier estimate.
  c.add(answer(1, 200))
  assert.equal(turn.usage.requests, 1)
  assert.equal(turn.usage.output, 200)
  near(turn.usage.score.points, 3.3)
  near(turn.totalScore.points, 3.3)
})

test('Claude persisted response scores freeze earlier rates across restart and file replay', () => {
  const scores = {}
  const c = new ClaudeConversation({ pricing, scores })
  c.add(user(1)); c.add(answer(1))
  const saved = JSON.parse(JSON.stringify(scores))
  const laterPricing = new Map([['anthropic/test-model', { ...rates, output: 100 }]])
  const replay = new ClaudeConversation({ pricing: laterPricing, scores: saved })
  replay.add(user(1)); replay.add(answer(1))
  near(replay.totalScore.points, 2.8)
  replay.add(user(2)); replay.add(answer(2))
  near(replay.totalScore.points, 10.1)
  replay.reset()
  replay.add(user(1)); replay.add(answer(1)); replay.add(user(2)); replay.add(answer(2))
  near(replay.totalScore.points, 10.1)
})

test('replaying multiple usage revisions keeps the response original rate snapshot', () => {
  const scores = {}
  const first = answer(1)
  const final = answer(1, 0)
  final.message.usage.input_tokens = 1500
  const c = new ClaudeConversation({ pricing, scores })
  c.add(user(1)); c.add(first); c.add(final)
  const recorded = c.totalScore.points
  const changed = new Map([['anthropic/test-model', { ...rates, input: 10, output: 100 }]])
  const replay = new ClaudeConversation({ pricing: changed, scores: JSON.parse(JSON.stringify(scores)) })
  replay.add(user(1)); replay.add(first); replay.add(final)
  near(replay.totalScore.points, recorded)
  const unknown = new ClaudeConversation()
  unknown.add(user(1)); unknown.add(first)
  assert.equal(unknown.totalScore.unpriced, 1)
  unknown.pricing = pricing
  unknown.add(first)
  assert.equal(unknown.totalScore.unpriced, 0)
  near(unknown.totalScore.points, 2.8)
})

test('Claude cumulative points outlive the displayed turn limit', () => {
  const c = new ClaudeConversation({ pricing })
  for (let i = 0; i < MAX_TURNS + 5; i++) { c.add(user(i)); c.add(answer(i)) }
  assert.equal(c.turns.length, MAX_TURNS)
  assert.equal(c.omitted, 5)
  near(c.turns.at(-1).totalScore.points, (MAX_TURNS + 5) * 2.8)
})

test('missing Claude usage is unknown and a late record clears only its own unknown marker', () => {
  const scores = {}
  const c = new ClaudeConversation({ pricing, scores })
  c.add(user(1))
  c.add({ type: 'system', subtype: 'turn_duration' })
  assert.equal(c.totalScore.unpriced, 1)
  c.add(answer(1))
  assert.equal(c.totalScore.unpriced, 0)
  near(c.totalScore.points, 2.8)
  assert.equal(scores['turn:u1'], undefined)
  const replay = new ClaudeConversation({ pricing, scores: { 'turn:u1': { score: { points: 0, priced: 0, unpriced: 1 } } } })
  replay.add(user(1)); replay.add(answer(1))
  assert.equal(replay.totalScore.unpriced, 0)
  near(replay.totalScore.points, 2.8)
})

test('Claude delegates in separate logs are explicitly unpriced, not silently free', () => {
  const c = new ClaudeConversation({ pricing })
  const event = answer(1)
  event.message.content = [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: {} }]
  c.add(user(1)); c.add(event); c.add({ ...event, uuid: 'another-block' })
  near(c.totalScore.points, 2.8)
  assert.equal(c.totalScore.unpriced, 1)
  assert.equal(c.totalScore.priced, 1)
})

test('Claude uses its own speed and the reported 1h cache-write split', () => {
  const fastPricing = new Map(pricing)
  fastPricing.fast = { models: ['anthropic/test-model'], periods: [[0, null]] }
  const c = new ClaudeConversation({ pricing: fastPricing })
  const event = answer(1)
  event.message.usage.cache_creation = { ephemeral_1h_input_tokens: 500 }
  event.message.usage.speed = 'standard'
  c.add(user(1)); c.add(event)
  near(c.totalScore.points, 3.175)
  const faster = answer(2)
  faster.message.usage.cache_creation = { ephemeral_1h_input_tokens: 500 }
  faster.message.usage.speed = 'fast'
  c.add(user(2)); c.add(faster)
  near(c.totalScore.points, 3.175 * 3)
})

test('normal sessions persist completed, failed and retried points without repricing older turns', async (t) => {
  let call = 0
  const f = await fixture(t, { getTurnUsage: async () => ({ requests: 1, input: 1000, output: 0, cacheRead: 0, cacheWrite: 0,
    reasoning: 0, cost: null, models: ['openai-codex/test'], score: { points: ++call, priced: 1, unpriced: 0 } }) })
  await f.manager.send(f.thread.id, { text: 'first' })
  await f.started.promise
  const first = f.manager.active.get(f.thread.id).done
  f.finish.resolve(); await first
  assert.equal(f.manager.summary(f.manager.threads.get(f.thread.id)).score.points, 1)
  await f.manager.send(f.thread.id, { text: 'next' })
  await f.manager.active.get(f.thread.id).done
  assert.equal(f.manager.summary(f.manager.threads.get(f.thread.id)).score.points, 3)
  await f.manager.shutdown()
  const restored = f.makeManager({ getTurnUsage: async () => { throw new Error('must not reprice') } })
  await restored.load()
  const snapshot = await restored.get(f.thread.id)
  assert.equal(snapshot.thread.score.points, 3)
  assert.deepEqual(snapshot.turns.map((turn) => turn.usage.score.points), [1, 2])
})
