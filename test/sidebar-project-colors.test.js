import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

const sidebar = await fs.readFile(new URL('../web/src/components/Sidebar.tsx', import.meta.url), 'utf8')

test('project headers never intercept scrolling to change colors', () => {
  assert.doesNotMatch(sidebar, /useWheelColor|stepColor|onWheel|addEventListener\(['"]wheel/)
  assert.doesNotMatch(sidebar, /ホイールで色を変更/)
})

test('project actions explicitly open a palette with every hue and no tint', () => {
  assert.match(sidebar, /label="色変更"\s+onSelect=\{\(\) => \{ close\(\); setColorOpen\(true\) \}\}/)
  assert.match(sidebar, /PROJECT_HUES\.map\(\(hue, index\)/)
  assert.match(sidebar, /aria-pressed=\{color === index\} disabled=\{savingColor\}/)
  assert.match(sidebar, /onClick=\{\(\) => void saveColor\(index\)\}/)
  assert.match(sidebar, /onClick=\{\(\) => void saveColor\(-1\)\}/)
  assert.match(sidebar, /act\('project.color', \{ path: group.path, color \}\)/)
  assert.match(sidebar, /if \(result !== null\) setColorOpen\(false\)/)
})
