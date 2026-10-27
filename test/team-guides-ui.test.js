import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { createSettingsService, migrateSettings } from '../server/settings.js'
import { providerReady, visibleModels } from '../web/src/model-selection.ts'

// Keep the editor's conflict-handling contract covered independently of a browser.
const source = () => fs.readFile(new URL('../web/src/components/TeamGuides.tsx', import.meta.url), 'utf8')

// Execute the real TSX handlers with minimal state/JSX adapters, not a duplicate
// of the deletion logic. Settings still go through the actual commit service.
async function editor(setting, initial, hooks = {}) {
  const slots = []
  const calls = []
  const notices = []
  let cursor = 0
  let saved = initial
  let persisted = JSON.stringify({ [setting]: initial })
  let live = migrateSettings(JSON.parse(persisted))
  const service = createSettingsService({
    getSettings: () => live,
    saveSettings: async (candidate) => {
      await hooks.save?.()
      persisted = JSON.stringify(candidate)
      return candidate
    },
    publishSettings: (candidate) => { live = candidate; saved = live[setting] },
  })
  const jsx = (type, props) => ({ type, props })
  const modules = {
    react: { useState: (initialValue) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = initialValue
      return [slots[index], (value) => { slots[index] = value }]
    } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': {},
    '../util': { copyText: async (text) => hooks.copy?.(text), parseModel: (value) => { const [provider, id] = JSON.parse(value); return { provider, id } } },
    '../store': {
      request: async (method, { patch }) => {
        calls.push({ method, patch: structuredClone(patch) })
        return service.update(patch)
      },
      toast: (...args) => notices.push(args),
    },
  }
  const { outputText } = ts.transpileModule(`${await source()}\nexport { GuideList, policyPrompt }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  const exports = {}
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(name in modules, `unexpected dependency: ${name}`)
    return modules[name]
  }, exports)
  const title = setting === 'teamPolicies' ? '方針' : 'プレイブック'
  const fields = (setting === 'teamPolicies' ? ['text'] : ['description', 'body'])
    .map((key) => ({ key, placeholder: key, label: key, max: 20_000 }))
  const render = () => {
    cursor = 0
    return exports.GuideList({ title, setting, saved, fields, prompt: exports.policyPrompt(hooks.groups ?? [], hooks.catalogLoaded ?? true) })
  }
  const find = (predicate, node = render()) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of [node.props?.children].flat(Infinity)) {
      if (!child || typeof child !== 'object') continue
      const found = find(predicate, child)
      if (found) return found
    }
  }
  return {
    calls, notices, find,
    get draft() { return slots[0] },
    get base() { return slots[1] },
    get error() { return slots[3] },
    restart: () => migrateSettings(JSON.parse(persisted)),
    delete: async (name) => {
      find((node) => node.props?.['aria-label'] === `${name}を削除`).props.onClick()
      await new Promise((resolve) => setImmediate(resolve))
    },
    edit: (name, value) => find((node) => node.type === 'input' && node.props.value === name).props.onChange({ target: { value } }),
    add: () => find((node) => node.type === 'button' && node.props.children?.includes(' 追加')).props.onClick(),
    externalSave: async (entries) => service.update({ [setting]: entries, teamGuidesBase: { [setting]: saved } }),
  }
}

for (const [setting, body] of [['teamPolicies', { text: 'original' }], ['teamPlaybooks', { description: 'when', body: 'original' }]]) {
  const entries = () => [{ id: 'a', name: 'A', ...body }, { id: 'b', name: 'B', ...body }]

  test(`${setting}: delete persists immediately, including deletion of the last entry`, async () => {
    const h = await editor(setting, entries())
    await h.delete('A')
    assert.deepEqual(h.restart()[setting], [entries()[1]])
    assert.deepEqual(h.draft, [entries()[1]])
    assert.deepEqual(h.calls[0].patch.teamGuidesBase[setting], entries())
    await h.delete('B')
    assert.deepEqual(h.restart()[setting], [])
    assert.deepEqual(h.draft, [])
    assert.equal(h.notices.length, 2)
  })

  test(`${setting}: delete preserves unrelated edits and incomplete additions without saving them`, async () => {
    const h = await editor(setting, entries())
    h.edit('B', 'Edited B')
    h.add()
    await h.delete('A')
    assert.deepEqual(h.restart()[setting], [entries()[1]])
    assert.equal(h.draft[0].name, 'Edited B')
    assert.equal(h.draft[1].name, '')
    assert.deepEqual(h.base, [entries()[1]])
    await h.delete(setting === 'teamPolicies' ? '方針' : 'プレイブック')
    assert.equal(h.calls.length, 1, 'unsaved additions are removed locally')
    assert.equal(h.draft.length, 1)
  })

  test(`${setting}: a failed deletion retains the entry and reports the error`, async () => {
    const h = await editor(setting, entries(), { save: () => { throw new Error('disk full') } })
    await h.delete('A')
    assert.deepEqual(h.draft, entries())
    assert.deepEqual(h.restart()[setting], entries())
    assert.match(h.error, /disk full/)
    assert.equal(h.notices.length, 0)
  })

  test(`${setting}: a stale deletion cannot overwrite another window's save`, async () => {
    const h = await editor(setting, entries())
    h.edit('B', 'Unsaved B')
    const external = entries().map((entry) => ({ ...entry, name: `External ${entry.name}` }))
    await h.externalSave(external)
    await h.delete('A')
    assert.deepEqual(h.restart()[setting], external)
    assert.equal(h.draft[0].name, 'A')
    assert.equal(h.draft[1].name, 'Unsaved B')
    assert.match(h.error, /別の画面で更新/)
    assert.equal(h.notices.length, 0)
  })
}

test('policy prompt copy includes benchmark research without changing settings', async () => {
  let copied
  const groups = [
    { id: 'claude-code', heading: 'Claude Code', models: [{ value: 'claude:haiku', name: 'Haiku' }] },
    { id: 'opencode-go', heading: 'OpenCode Go', models: [
      { value: JSON.stringify(['opencode-go', 'first-model']), name: 'First Model' },
      { value: JSON.stringify(['opencode-go', 'second-model']), name: 'Second Model' },
    ] },
    { id: 'anthropic', heading: 'Claude API', models: [{ value: JSON.stringify(['anthropic', 'first-model']), name: 'First Model' }] },
  ]
  const h = await editor('teamPolicies', [], { groups, copy: (text) => { copied = text } })
  const button = h.find((node) => node.type === 'button' && node.props.children?.includes(' 方針作成指示文をコピー'))
  assert.ok(button)
  button.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(copied, /現在のチームの選択済みモデルだけに絞らない/)
  assert.match(copied, /表示名とIDは一覧をそのまま使い、名前とIDの対応調査や説明は不要/)
  assert.match(copied, /別名などで性能や料金を特定できない場合だけ必要な範囲で確認/)
  assert.match(copied, /OpenCode Go.*first-model/)
  assert.match(copied, /OpenCode Go.*second-model/)
  assert.match(copied, /Claude API.*first-model/)
  assert.match(copied, /Claude Code.*haiku/)
  assert.match(copied, /未接続・非表示のモデルは含まれません/)
  assert.match(copied, /ベンチマーク/)
  assert.match(copied, /【モデル別の比較】[\s\S]*- 得意：[\s\S]*- 不得意：[\s\S]*- 総合性能：[\s\S]*- コスト（API料金）：/)
  assert.match(copied, /【モデル別の比較】[\s\S]*【ベンチマークと比較上の注意】[\s\S]*【方針に貼る文章】[\s\S]*【情報源と不明点】/)
  assert.match(copied, /各モデルの4項目と作業別の使い分け・代替方法/)
  assert.match(copied, /入力・出力の単価、通貨、単位と条件/)
  assert.match(copied, /サブスクやローカルの実費とは区別/)
  assert.match(copied, /全モデルが収まらなければ省略せず/)
  assert.match(copied, /2,000文字以内/)
  assert.match(copied, /設定やモデル選択は変更しない/)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.notices, [['方針作成指示文をコピーしました', 'success']])
  const playbooks = await editor('teamPlaybooks', [])
  assert.equal(playbooks.find((node) => node.type === 'button' && node.props.children?.includes(' 方針作成指示文をコピー')), undefined)
})

test('policy prompt receives the real picker candidates, including all OpenCode Go models', async () => {
  const source = await fs.readFile(new URL('../web/src/components/WorkflowModelField.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
  const modules = {
    'react/jsx-runtime': {}, 'lucide-react': {}, '../model-selection': { providerReady, visibleModels },
    '../util': {}, './Pickers': { byNewest: (a, b) => a.id.localeCompare(b.id), providerHeading: (server, provider) => provider === 'anthropic' ? 'Claude（API）' : server.catalog.providers[provider] ?? provider, PROVIDER_NOTE: {}, PROVIDER_ORDER: ['opencode-go', 'anthropic'] },
    './Popover': {}, './useWheelSelect': {},
  }
  const exports = {}
  new Function('require', 'exports', outputText)((name) => { assert.ok(name in modules, name); return modules[name] }, exports)
  const model = (provider, id, extra = {}) => ({ provider, id, name: id, value: JSON.stringify([provider, id]), ...extra })
  const hidden = model('opencode-go', 'hidden')
  const server = {
    catalog: { providers: { 'opencode-go': 'OpenCode Go' }, models: [model('opencode-go', 'model-a'), model('opencode-go', 'model-b'), hidden, model('opencode-go', 'retired', { retired: true }), model('anthropic', 'disconnected')] },
    settings: { modelVisibility: { [hidden.value]: false } },
    accounts: { chatgpt: { signedIn: false }, claude: { configured: false }, deepseek: { configured: false }, opencodeGo: { configured: true } },
  }
  const groups = exports.modelGroups(server)
  let copied
  const h = await editor('teamPolicies', [], { groups, copy: (text) => { copied = text } })
  h.find((node) => node.type === 'button' && node.props.children?.includes(' 方針作成指示文をコピー')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(copied, /OpenCode Go.*model-a/)
  assert.match(copied, /OpenCode Go.*model-b/)
  assert.doesNotMatch(copied, /ID: \"(?:hidden|retired|disconnected)\"/)
  server.accounts.claude.configured = true
  const connected = await editor('teamPolicies', [], { groups: exports.modelGroups(server), copy: (text) => { copied = text } })
  connected.find((node) => node.type === 'button' && node.props.children?.includes(' 方針作成指示文をコピー')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(copied, /Claude Code.*haiku/)
  assert.match(copied, /Claude（API）.*disconnected/)
})

test('policy prompt warns when the catalog is empty', async () => {
  let copied
  const h = await editor('teamPolicies', [], { catalogLoaded: false, copy: (text) => { copied = text } })
  h.find((node) => node.type === 'button' && node.props.children?.includes(' 方針作成指示文をコピー')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(copied, /カタログが空のため、一覧は不完全/)
  assert.match(copied, /候補を取得できませんでした/)
})

test('policy prompt copy reports clipboard errors', async () => {
  const h = await editor('teamPolicies', [], { copy: () => { throw new Error('clipboard denied') } })
  h.find((node) => node.type === 'button' && node.props.children?.includes(' 方針作成指示文をコピー')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.notices, [['コピーできませんでした', 'error']])
  assert.deepEqual(h.calls, [])
})

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
