import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateSettings, planSettingsUpdate } from '../server/settings.js'

test('observer model starts unset and remains independent of ordinary task defaults', () => {
  const old = migrateSettings({ defaultModel: 'old', defaultEffort: 'high' })
  assert.equal(old.observerModel, null)
  const choice = { model: 'claude:haiku', effort: 'low' }
  const next = planSettingsUpdate(old, { observerModel: choice }, 1).settings
  assert.deepEqual(next.observerModel, choice)
  assert.equal(next.defaultModel, 'old')
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(next))).observerModel, choice)
  assert.equal(planSettingsUpdate(next, { observerModel: null }, 1).settings.observerModel, null)
})

test('observer model validates the entire choice before applying a patch', () => {
  const old = migrateSettings({})
  for (const observerModel of ['', {}, [], { model: '', effort: null }, { model: 'x' }, { model: 'x', effort: 1 }, { model: 'x'.repeat(1001), effort: null }]) {
    assert.throws(() => planSettingsUpdate(old, { observerModel }, 1))
  }
  assert.equal(old.observerModel, null)
})
