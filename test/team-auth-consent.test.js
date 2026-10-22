import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authConsentState, needsClaudeAuth } from '../web/src/team-auth-consent.ts'

const inspection = (mode, extra = {}) => ({ descriptor: { version: 1, mode, authMethod: 'unknown', apiProvider: 'unknown' }, challenge: 'fresh-challenge', confirmed: false, ...extra })

test('no CLI mode is silently authorized by merely inspecting it', () => {
  assert.deepEqual(authConsentState(null), { ready: false })
  for (const mode of ['subscription', 'api', 'cloud', 'unknown', 'logged-out']) {
    assert.deepEqual(authConsentState(inspection(mode)), { ready: false }, mode)
  }
})

test('explicit acceptance passes the challenge; unknown adds a separate risk acknowledgement', () => {
  for (const mode of ['subscription', 'api', 'cloud']) {
    assert.deepEqual(authConsentState(inspection(mode), true), { ready: true, confirmation: { challenge: 'fresh-challenge' } })
  }
  assert.deepEqual(authConsentState(inspection('unknown'), true), {
    ready: true, confirmation: { challenge: 'fresh-challenge', acknowledgeUnknown: true },
  })
  assert.deepEqual(authConsentState(inspection('unknown'), false), { ready: false })
})

test('missing challenges and logged-out states cannot be accepted; existing matched consent can be reused', () => {
  assert.deepEqual(authConsentState(inspection('api', { challenge: null }), true), { ready: false })
  assert.deepEqual(authConsentState(inspection('logged-out'), true), { ready: false })
  assert.deepEqual(authConsentState(inspection('logged-out', { confirmed: true }), true), { ready: false })
  assert.deepEqual(authConsentState(inspection('api', { confirmed: true })), { ready: true })
})

test('auth requirement preserves choices and allows disabling Claude without accepting charges', () => {
  const config = { leaderProvider: 'gpt', claude: { enabled: false }, claudeApi: { enabled: true } }
  const snapshot = structuredClone(config)
  assert.equal(needsClaudeAuth(config), false)
  assert.equal(needsClaudeAuth({ ...config, leaderProvider: 'claude' }), true)
  assert.equal(needsClaudeAuth({ ...config, claude: { enabled: true } }), true)
  assert.equal(needsClaudeAuth(config, { leaderKind: 'terminal', children: [] }), true)
  assert.equal(needsClaudeAuth(config, { leaderKind: 'thread', children: [{ kind: 'agent', state: 'closed' }] }), false)
  assert.equal(needsClaudeAuth(config, { leaderKind: 'thread', children: [{ kind: 'agent', state: 'removed' }] }), false)
  assert.equal(needsClaudeAuth(config, { leaderKind: 'thread', children: [{ kind: 'thread', state: 'running' }] }), false)
  assert.deepEqual(config, snapshot)
})
