import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

// Keep the editor's conflict-handling contract covered without a TSX/browser loader.
const source = () => fs.readFile(new URL('../web/src/components/TeamGuides.tsx', import.meta.url), 'utf8')

test('guide editor keeps the original base while dirty and sends it with saves', async () => {
  const code = await source()
  assert.match(code, /if \(!same\(saved, base\) && \(same\(draft, base\) \|\| same\(draft, saved\)\)\) \{\s*setBase\(saved\)\s*setDraft\(saved\)/)
  assert.match(code, /request\('settings\.update', \{ patch: \{ \[setting\]: draft, teamGuidesBase: \{ \[setting\]: base \} \} \}\)/)
  assert.match(code, /catch \(cause\) \{\s*setError\(/, 'failed saves retain the draft and base')
})

test('resetting a conflicting guide reloads both the saved draft and its base', async () => {
  const code = await source()
  assert.match(code, /onClick=\{\(\) => \{ setDraft\(saved\); setBase\(saved\); setError\(null\) \}\} disabled=\{saving\}>元に戻す/)
  assert.match(code, /readOnly: saving/)
  assert.match(code, /disabled=\{invalid \|\| saving\}/)
})
