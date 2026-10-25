import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSettingsService, DEFAULT_SETTINGS } from '../server/settings.js'
import { createAccountHandlers } from '../server/rpc-handlers-accounts.js'

const cases = [
  ['localLlm.set', { baseURL: 'http://localhost:1234/v1' }, settings => settings.localLlm.baseURL === 'http://localhost:1234/v1'],
  ['localLlm.remove', {}, settings => settings.localLlm.baseURL === null],
  ['account.setWorkspace', { workspaceId: 'wrkspc_test' }, settings => settings.anthropicWorkspaceId === 'wrkspc_test'],
]

function setup(failure) {
  let live = structuredClone(DEFAULT_SETTINGS)
  live.localLlm = { baseURL: 'http://old/v1', models: [] }
  const events = []
  const cause = new Error(`${failure} unavailable`)
  const service = createSettingsService({
    getSettings: () => live,
    saveSettings: async candidate => {
      events.push('save')
      if (failure === 'save') throw cause
      return candidate
    },
    publishSettings: saved => { live = saved; events.push('settings') },
  })
  const accountsNow = [{ id: 'account' }]
  const handlers = createAccountHandlers({
    getSettings: () => live,
    credentials: { read: async () => ({ refs: {} }), unsetRef: async () => { events.push('credential') } },
    discoverModels: async () => [{ id: 'local-model' }],
    updateSettings: patch => service.update(patch),
    setAnthropicWorkspace: id => service.mutate(candidate => { candidate.anthropicWorkspaceId = id }),
    accounts: async () => { events.push('accounts'); if (failure === 'accounts') throw cause; return accountsNow },
    broadcast: () => { events.push('broadcast'); if (failure === 'broadcast') throw cause },
  })
  return { handlers, events, cause, accountsNow, get live() { return live } }
}

for (const [method, input, committed] of cases) {
  for (const failure of ['accounts', 'broadcast']) {
    test(`${method}: ${failure} failure after save is identified as committed`, async () => {
      const h = setup(failure)
      await assert.rejects(h.handlers[method](input), error => {
        assert.equal(error.settingsCommitted, true)
        assert.strictEqual(error.cause, h.cause)
        assert.match(error.message, /保存済み/)
        return true
      })
      assert.ok(committed(h.live))
      assert.deepEqual(h.events.filter(event => event !== 'credential'), failure === 'accounts'
        ? ['save', 'settings', 'accounts'] : ['save', 'settings', 'accounts', 'broadcast'])
    })
  }
  test(`${method}: save failure is not reported as committed and skips accounts notification`, async () => {
    const h = setup('save')
    const before = structuredClone(h.live)
    await assert.rejects(h.handlers[method](input), error => {
      assert.strictEqual(error, h.cause)
      assert.notEqual(error.settingsCommitted, true)
      return true
    })
    assert.deepEqual(h.live, before)
    assert.deepEqual(h.events.filter(event => event !== 'credential'), ['save'])
  })
  test(`${method}: success preserves result and notification order`, async () => {
    const h = setup()
    const result = await h.handlers[method](input)
    assert.ok(committed(h.live))
    assert.deepEqual(h.events.filter(event => event !== 'credential'), ['save', 'settings', 'accounts', 'broadcast'])
    if (method === 'account.setWorkspace') assert.deepEqual(result, { check: null, accounts: h.accountsNow })
    else {
      assert.strictEqual(result.settings, h.live)
      if (method === 'localLlm.set') assert.deepEqual(result.models, [{ id: 'local-model' }])
    }
  })
}

test('account.setWorkspace validation failure does not save or notify', async () => {
  const h = setup()
  await assert.rejects(h.handlers['account.setWorkspace']({ workspaceId: 'invalid' }), /ワークスペース ID/)
  assert.deepEqual(h.events, [])
})

test('localLlm.set invalid key does not save or notify', async () => {
  const h = setup()
  await assert.rejects(h.handlers['localLlm.set']({ baseURL: 'http://localhost:1234/v1', key: 'bad key' }), /空白/)
  assert.deepEqual(h.events, [])
})
