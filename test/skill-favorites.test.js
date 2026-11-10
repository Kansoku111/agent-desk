import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS, migrateSettings, planSettingsUpdate } from '../server/settings.js'

const update = (current, patch) => planSettingsUpdate(current, { favoriteSkills: patch }, 0).settings

test('skill favorites migrate, merge by name, persist and can be removed', () => {
  const legacy = migrateSettings({})
  assert.deepEqual(legacy.favoriteSkills, {})
  const first = update(legacy, { zeta: true })
  const second = update(first, { alpha: true })
  assert.deepEqual(second.favoriteSkills, { zeta: true, alpha: true })
  assert.deepEqual(update(second, { zeta: false }).favoriteSkills, { alpha: true })
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(second))).favoriteSkills, second.favoriteSkills)
  assert.deepEqual(DEFAULT_SETTINGS.favoriteSkills, {})
})

test('skill favorites validate patches and preserve special names safely', () => {
  const initial = migrateSettings({})
  for (const patch of [null, [], { '': true }, { ' ': true }, { skill: 'yes' }, { ['x'.repeat(1001)]: true }]) {
    assert.throws(() => update(initial, patch))
  }
  const next = update(initial, JSON.parse('{"__proto__":true}'))
  assert.equal(Object.hasOwn(next.favoriteSkills, '__proto__'), true)
  assert.deepEqual(update(next, JSON.parse('{"__proto__":false}')).favoriteSkills, {})
  assert.deepEqual(initial.favoriteSkills, {})
})
