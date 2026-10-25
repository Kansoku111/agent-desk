import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

const sidebar = await fs.readFile(new URL('../web/src/components/Sidebar.tsx', import.meta.url), 'utf8')
const css = await fs.readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8')
const modes = { ab: 'purple', ex: 'green', tm: 'focus', cl: 'amber' }

test('project launch buttons share typography, not Claude colors', () => {
  for (const mode of Object.keys(modes)) {
    assert.ok(sidebar.includes(`className="icon-button small task-start-button ${mode}-button"`))
  }
  assert.doesNotMatch(sidebar, /className="[^"]*cl-button\s+(?:ex|tm)-button/)
})

test('each launch mode owns a distinct theme-aware color, retained on interaction', () => {
  assert.match(css, /\.icon-button\.task-start-button\s*\{\s*color: var\(--task-action-color\);/)
  for (const [mode, color] of Object.entries(modes)) {
    assert.ok(css.includes(`.task-start-button.${mode}-button { --task-action-color: var(--${color}); }`))
  }
  assert.match(css, /\.task-group-actions \.task-start-button:is\(:hover, :focus-visible\)\s*\{\s*background: color-mix\(in srgb, var\(--task-action-color\)/)
  // Both system dark mode and the explicit dark override need the AB token.
  assert.equal((css.match(/--purple: #c4a7ff;/g) ?? []).length, 2)
  assert.match(css, /--purple: #8250df;/)
})
