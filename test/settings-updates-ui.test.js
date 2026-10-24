import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

// Like the context-choice UI contract in codex-models.test.js, keep these
// ownership/layout regressions independent of a browser or TSX test loader.
const settingsSource = (name) => fs.readFile(new URL(`../web/src/components/settings/${name}.tsx`, import.meta.url), 'utf8')
async function updatesCardSource() {
  const source = await settingsSource('AboutSettings')
  const start = source.indexOf('function UpdatesCard(')
  const end = source.indexOf('export function AboutSettings(', start)
  assert.ok(start >= 0 && end > start, 'About settings must own UpdatesCard')
  return source.slice(start, end)
}

test('model settings no longer owns model synchronization UI or actions', async () => {
  const source = await settingsSource('ModelsSettings')
  assert.doesNotMatch(source, /ModelUpdateCard|modelAutoUpdate|modelUpdate\.check|server\?*\.modelUpdate/)
  assert.doesNotMatch(source, /自動で同期する|同期の詳細|今すぐ確認/)
  // Consolidating updates must not remove the actual model preferences.
  for (const component of ['ModelVisibility', 'FastMode', 'ContextSizes', 'Subagents']) {
    assert.match(source, new RegExp(`<${component}\\b`))
  }
})

test('About updates owns the auto-sync checkbox and persists the setting', async () => {
  const source = await updatesCardSource()
  assert.match(source, /settings\.modelAutoUpdate\)?\s*!==\s*false/)
  const inputs = [...source.matchAll(/<input\b[\s\S]*?\/>/g)].map(([input]) => input)
  const toggle = inputs.find((input) => /modelAutoUpdate/.test(input))
  assert.ok(toggle, 'the auto-sync settings action must belong to an input in UpdatesCard')
  assert.match(toggle, /type="checkbox"/)
  assert.match(toggle, /checked=\{[^}]+\}/)
  assert.match(toggle, /act\('settings\.update',\s*\{\s*patch:\s*\{\s*modelAutoUpdate:\s*event\.target\.checked\s*\}/)
})

test('About keeps synchronization diagnostics in native details collapsed by default', async () => {
  const source = await updatesCardSource()
  const details = /<details\b([^>]*)>([\s\S]*?)<\/details>/.exec(source)
  assert.ok(details, 'sync diagnostics need a disclosure rather than a second always-visible card')
  assert.doesNotMatch(details[1], /\bopen\b/, 'sync details must start collapsed')
  assert.match(details[2], /<summary>同期の詳細<\/summary>/)
  assert.match(details[2], /モデル定義/)
  assert.match(details[2], /ChatGPT アカウントの一覧/)
  assert.match(details[2], /提供終了の可能性/)
  assert.match(details[2], /最終確認/)
  assert.match(details[2], /前回追加/)
  assert.doesNotMatch(details[2], /今すぐ確認|modelUpdate\.check/, 'details must not introduce a second manual check')
})

test('About shows OpenCode Go as its own update row even without an API key or auto-sync', async () => {
  const source = await updatesCardSource()
  const row = /<div className="update-row">\s*<span className="update-name">OpenCode Go<\/span>([\s\S]*?)<\/div>/.exec(source)
  assert.ok(row, 'OpenCode Go must be visible in the update list, not only in collapsed sync details')
  assert.match(row[1], /!opencodeConfigured\s*\?\s*'API キー未設定'/)
  assert.match(row[1], /!autoSync\s*\?\s*'自動同期オフ'/)
  assert.match(row[1], /busy\s*\?\s*'確認中…'/)
  assert.match(row[1], /opencode\?\.checkedAt/)
  assert.match(row[1], /opencodeConfigured && autoSync && !busy/)
  assert.match(row[1], /opencode\?\.error/)
  assert.match(source, /\)\}\s*<div className="update-row">\s*<span className="update-name">OpenCode Go/)
})

test('About separates OpenCode model additions and errors from the general model row', async () => {
  const source = await updatesCardSource()
  assert.match(source, /const recentModels = recent\?\.models\.filter\(\(model\) => model\.provider !== 'opencode-go'\)/)
  assert.match(source, /const recentOpenCode = recent\?\.models\.filter\(\(model\) => model\.provider === 'opencode-go'\)/)
  const go = /<span className="update-name">OpenCode Go<\/span>([\s\S]*?)<\/div>/.exec(source)[1]
  const other = /<span className="update-name">モデル<\/span>([\s\S]*?)<\/div>/.exec(source)[1]
  assert.match(go, /recentOpenCode\.map/)
  assert.doesNotMatch(go, /recentModels\.map/)
  assert.match(other, /recentModels\.map/)
  assert.doesNotMatch(other, /recentOpenCode|opencode\?\.error|models\.opencodeGo\?\.error/)
})

test('OpenCode cannot show a success check while definitions are missing or cannot be refreshed', async () => {
  const source = await updatesCardSource()
  const row = /<span className="update-name">OpenCode Go<\/span>([\s\S]*?)<\/div>/.exec(source)[1]
  assert.match(row, /opencodeMissing\s*\?\s*`定義待ち \$\{opencodeMissing\}件`/)
  assert.match(row, /!opencodeMissing && !opencode\?\.definitionError/)
  assert.match(row, /AlertTriangle[\s\S]*?aria-label="モデル定義の同期が未完了"/)
  assert.ok(row.indexOf('opencodeMissing ?') < row.indexOf('recentOpenCode.length'))
  assert.match(source, /registry: 'OpenCode 公式カタログ'/)
})

test('About exposes one shared manual check for application and model updates', async () => {
  const source = await updatesCardSource()
  assert.match(source, /await\s+Promise\.all\(\[\s*act\('updates\.check'\),\s*act\('modelUpdate\.check'\)\s*\]\)/)
  assert.equal([...source.matchAll(/act\('updates\.check'\)/g)].length, 1)
  assert.equal([...source.matchAll(/act\('modelUpdate\.check'\)/g)].length, 1)
  const buttons = [...source.matchAll(/<button\b[\s\S]*?<\/button>/g)].map(([button]) => button)
  const checkButtons = buttons.filter((button) => /今すぐ確認/.test(button))
  assert.equal(checkButtons.length, 1, 'updates and models must share a single manual check button')
  assert.match(checkButtons[0], /onClick=\{\(\) => void check\(\)\}/)
  assert.match(checkButtons[0], /disabled=\{busy\}/)
  assert.match(source, /const busy = checking \|\| updates\.checking \|\| \w+\?\.phase === 'checking'/)
})
