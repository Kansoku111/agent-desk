import test from 'node:test'
import assert from 'node:assert/strict'
import { fallbackProvider, usageFallbackChoice, validateUsageFallbackRoutes } from '../shared/usage-fallback.js'

const gpt = '["openai-codex","luna"]'
const api = '["anthropic","example"]'
const routes = [
  { model: 'claude:haiku', effort: 'low' },
  { model: gpt, effort: 'low' },
  { model: api, effort: 'low' },
]

test('selects the first configured route other than the exhausted provider', () => {
  assert.deepEqual(usageFallbackChoice(routes, 'claude:opus'), routes[1])
  assert.deepEqual(usageFallbackChoice(routes, '["openai-codex","other"]'), routes[0])
  assert.equal(usageFallbackChoice([routes[0]], 'claude:opus'), null)
  assert.equal(usageFallbackChoice(routes, 'unknown'), null)
})

test('distinguishes Claude Code from the separately billed API route', () => {
  assert.equal(fallbackProvider('claude:haiku'), 'claude-code')
  assert.equal(fallbackProvider('claude:'), 'claude-code')
  assert.throws(() => validateUsageFallbackRoutes([{ model: 'claude:', effort: '' }]), /不正/)
  assert.equal(fallbackProvider(api), 'anthropic')
  assert.deepEqual(usageFallbackChoice([routes[2]], 'claude:opus'), routes[2])
})

test('rejects malformed routes and duplicate providers', () => {
  assert.deepEqual(validateUsageFallbackRoutes(routes), routes)
  assert.throws(() => validateUsageFallbackRoutes([{ model: 'invalid', effort: '' }]), /不正/)
  assert.throws(() => validateUsageFallbackRoutes([routes[1], { model: '["openai-codex","other"]', effort: '' }]), /同じ接続先/)
  assert.equal(fallbackProvider('["openai-codex"]'), null)
})
