import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignProjectColors, isProjectColor, PROJECT_COLOR_COUNT } from '../server/project-colors.js'

test('new projects get colors not used yet, and chosen colors stay', () => {
  const paths = Array.from({ length: PROJECT_COLOR_COUNT }, (_, index) => `C:\\work\\p${index}`)
  const colors = assignProjectColors({}, paths)
  assert.equal(new Set(Object.values(colors)).size, PROJECT_COLOR_COUNT)
  assert.equal(assignProjectColors(colors, paths), null)

  const kept = assignProjectColors({ 'C:\\a': 3, 'C:\\b': -1 }, ['C:\\a', 'C:\\b', 'C:\\c'])
  assert.equal(kept['C:\\a'], 3)
  assert.equal(kept['C:\\b'], -1)
  assert.notEqual(kept['C:\\c'], 3)
})

test('isProjectColor accepts the palette and "no tint" only', () => {
  assert.ok(isProjectColor(-1))
  assert.ok(isProjectColor(PROJECT_COLOR_COUNT - 1))
  assert.ok(!isProjectColor(PROJECT_COLOR_COUNT))
  assert.ok(!isProjectColor(1.5))
  assert.ok(!isProjectColor('2'))
})
