import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelHandlers } from '../server/rpc-handlers-models.js'

test('manual model refresh checks prices before the shared Go registry is needed', async () => {
  const calls = []
  const handlers = createModelHandlers({
    threads: { busy: false }, catalog: {}, catalogState: () => ({}), updates: {},
    modelUpdater: { check: async () => calls.push('pi') }, modelUpdateState: () => ({}),
    checkEquivalentPricing: async () => calls.push('prices'), refreshCodexModels: async () => calls.push('account'),
    checkOpenCodeGoModels: async () => calls.push('go'),
  })
  await handlers['modelUpdate.check']()
  assert.deepEqual(calls, ['prices', 'account', 'pi', 'go'])
})

test('catalog.refresh restores cached models when warming fails', async () => {
  const models = [{ provider: 'anthropic', id: 'claude-sonnet-5' }]
  const catalog = { data: { models } }
  const handlers = createModelHandlers({
    threads: { busy: false, warmCatalog: async () => { throw new Error('runtime unavailable') } },
    catalog,
    catalogState: () => ({ models: catalog.data.models }),
    updates: {},
    modelUpdater: {},
    modelUpdateState: () => ({}),
    refreshCodexModels: async () => {},
  })

  await assert.rejects(handlers['catalog.refresh'](), /runtime unavailable/)
  assert.deepEqual(catalog.data.models, models)
})
