import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { codexChoice } from '../web/src/codex-selection.ts'

const models = [
  { id: 'one', name: 'Model One', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  { id: 'two', name: 'Model Two', efforts: ['low', 'high'], defaultEffort: 'low' },
]

test('changing Codex model preserves a supported reasoning level', () => {
  assert.deepEqual(codexChoice(models, 'two', 'high'), { model: 'two', effort: 'high' })
  assert.deepEqual(codexChoice(models, 'one', 'minimal'), { model: 'one', effort: 'minimal' })
})

test('unsupported reasoning uses the chosen model default, not another model', () => {
  assert.deepEqual(codexChoice(models, 'two', 'xhigh'), { model: 'two', effort: 'low' })
  assert.deepEqual(codexChoice(models, 'one', null), { model: 'one', effort: 'medium' })
  assert.deepEqual(codexChoice([{ id: 'first', name: 'First', efforts: ['none', 'low'], defaultEffort: 'unknown' }], 'first', null), { model: 'first', effort: 'none' })
})

test('unknown and empty Codex catalogs never choose a different model', () => {
  assert.equal(codexChoice(models, 'removed', 'low'), null)
  assert.equal(codexChoice(models, null, 'low'), null)
  assert.equal(codexChoice([], 'one', 'low'), null)
  assert.deepEqual(codexChoice([{ id: 'plain', name: 'Plain', efforts: [] }], 'plain', null), { model: 'plain', effort: null })
})

test('picker selection keeps the complete capability list unchanged', () => {
  const before = structuredClone(models)
  codexChoice(models, 'two', 'xhigh')
  assert.deepEqual(models, before)
})

test('GP uses the CL-style popup and each wheel span instead of native selects', async () => {
  const view = await fs.readFile(new URL('../web/src/components/CodexView.tsx', import.meta.url), 'utf8')
  const picker = await fs.readFile(new URL('../web/src/components/CodexModelPicker.tsx', import.meta.url), 'utf8')
  const wheel = await fs.readFile(new URL('../web/src/components/useWheelSelect.ts', import.meta.url), 'utf8')
  assert.match(view, /<CodexModelPicker/)
  assert.doesNotMatch(view, /<select aria-label="(?:モデル|推論レベル)"/)
  assert.match(picker, /terminal-picker-columns/)
  assert.match(picker, /models[.]map/)
  assert.match(picker, /levels[.]map/)
  assert.match(picker, /ref=\{modelWheel[.]ref\}/)
  assert.match(picker, /ref=\{effortWheel[.]ref\}/)
  assert.match(picker, /modelWheel[.]cancel[(][)]/)
  assert.match(picker, /effortWheel[.]cancel[(][)]/)
  assert.match(wheel, /pending: pending !== null, cancel/)
})
