import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveHarness } from '../server/team-harness.js'
import { MAX_CHILDREN_LIMIT } from '../shared/team-limits.js'
import { createSettingsService, DEFAULT_SETTINGS, effectiveCustomInstructions, migrateSettings, planSettingsUpdate } from '../server/settings.js'

const instruction = (body, overrides = {}) => ({ id: 'test', title: 'ルール', body, enabled: true, targets: { dsh: true, claude: true }, ...overrides })
const instructionPatch = (body) => ({ customInstructionItems: [instruction(body)], customInstructionItemsBase: [] })
const defaults = (patch = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function harness(initial = {}, hooks = {}) {
  let live = defaults(initial)
  const events = []
  const writes = []
  const published = []
  const service = createSettingsService({
    getSettings: () => live,
    saveSettings: async (candidate) => {
      events.push('save')
      await hooks.save?.(candidate)
      const saved = hooks.decorate ? hooks.decorate(candidate) : structuredClone(candidate)
      writes.push(saved)
      return saved
    },
    publishSettings: (saved) => {
      live = saved
      published.push(saved)
      events.push('publish')
    },
    applyFastMode: async () => { events.push('fast'); await hooks.fast?.(live) },
    updateModelCatalog: async () => {
      events.push('catalog')
      return hooks.catalog ? hooks.catalog(live) : { restartRequired: true }
    },
    applyTeamChildPatch: async () => { events.push('team-child') },
    applyHomePatch: async () => {
      events.push('home')
      return hooks.home ? hooks.home(live) : true
    },
    restartRuntimesWhenIdle: async () => { events.push('restart'); await hooks.restart?.(live) },
    onChannelChange: () => { events.push('channel') },
    checkModelUpdate: () => { events.push('model-check'); return hooks.modelCheck?.() },
    onBackgroundError: (error) => { events.push(`background-error:${error.message}`) },
    now: hooks.now ?? (() => 1234),
  })
  return { service, events, writes, published, get live() { return live } }
}

test('fallback routes are explicit, validated, and survive settings reload', async () => {
  const legacy = migrateSettings({ agentTeams: { leaderFallback: 'claude:haiku' } })
  assert.equal(legacy.usageFallbackRoutes, null)
  assert.equal(legacy.agentTeams.leaderFallback, 'claude:haiku')
  const h = harness(legacy)
  const routes = [{ model: '["openai-codex","luna"]', effort: 'low' }]
  await h.service.update({ usageFallbackRoutes: routes, usageFallbackRoutesBase: null })
  assert.deepEqual(migrateSettings(h.writes[0]).usageFallbackRoutes, routes)
  await assert.rejects(h.service.update({ usageFallbackRoutes: [{ model: 'bad', effort: '' }], usageFallbackRoutesBase: routes }), /不正/)
  await assert.rejects(h.service.update({ usageFallbackRoutes: [], usageFallbackRoutesBase: null }), /別の画面/)
  await assert.rejects(h.service.update({ usageFallbackRoutes: [] }), /別の画面/)
  assert.deepEqual(h.live.usageFallbackRoutes, routes)
})

test('concurrent fallback editors cannot overwrite a newer committed route', async () => {
  const h = harness()
  const a = [{ model: 'claude:haiku', effort: 'low' }]
  const b = [{ model: '["openai-codex","luna"]', effort: 'low' }]
  const first = h.service.update({ usageFallbackRoutes: a, usageFallbackRoutesBase: null })
  const second = h.service.update({ usageFallbackRoutes: b, usageFallbackRoutesBase: null })
  await first
  await assert.rejects(second, /別の画面/)
  assert.deepEqual(h.live.usageFallbackRoutes, a)
})

test('legacy instructions keep their text and on/off state as one item for both targets', () => {
  for (const enabled of [true, false, undefined]) {
    const legacy = migrateSettings({ customInstructions: '  saved instructions\n', customInstructionsEnabled: enabled })
    assert.deepEqual(legacy.customInstructionItems, [instruction('  saved instructions\n', { id: 'legacy', title: '既存のカスタム指示', enabled: enabled !== false })])
    assert.ok(!Object.hasOwn(legacy, 'customInstructions') && !Object.hasOwn(legacy, 'customInstructionsEnabled'))
    for (const target of ['dsh', 'claude']) assert.equal(effectiveCustomInstructions(legacy, target), enabled === false ? '' : '  saved instructions\n')
    assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(legacy))), legacy)
  }
  assert.deepEqual(migrateSettings({ customInstructionItems: [], customInstructions: 'not resurrected' }).customInstructionItems, [])
})

test('saved items filter by target and only changes to effective dsh text restart dsh', async () => {
  const h = harness()
  const save = (items) => h.service.update({ customInstructionItems: items, customInstructionItemsBase: h.live.customInstructionItems })
  const dsh = instruction('one', { targets: { dsh: true, claude: false } })
  const claude = instruction('two', { id: 'claude', targets: { dsh: false, claude: true } })
  const shared = instruction('three', { id: 'shared' })
  await save([claude])
  assert.deepEqual(h.events.splice(0), ['save', 'publish'])
  await save([dsh, claude, shared])
  assert.deepEqual(h.events.splice(0), ['save', 'publish', 'home', 'restart'])
  assert.equal(effectiveCustomInstructions(h.live, 'dsh'), 'one\n\nthree')
  assert.equal(effectiveCustomInstructions(h.live, 'claude'), 'two\n\nthree')
  const off = { ...shared, enabled: false }
  await save([dsh, claude, off])
  assert.equal(effectiveCustomInstructions(h.live, 'claude'), 'two')
  assert.equal(effectiveCustomInstructions(h.live, 'dsh'), 'one')
  assert.deepEqual(h.events.splice(0), ['save', 'publish', 'home', 'restart'])
  await save([dsh, claude, { ...off, body: 'edited while off' }])
  assert.deepEqual(h.events.splice(0), ['save', 'publish'])
  assert.equal(migrateSettings(h.live).customInstructionItems[2].body, 'edited while off')
  await save([dsh, claude, { ...h.live.customInstructionItems[2], enabled: true }])
  assert.equal(effectiveCustomInstructions(h.live, 'dsh'), 'one\n\nedited while off')
  await save([dsh, claude])
  assert.equal(effectiveCustomInstructions(h.live, 'dsh'), 'one')
})

test('item list validation is atomic and rejects stale editors', async () => {
  const h = harness()
  for (const value of [null, [null], [instruction('x'), instruction('y')], [instruction(42)],
    [instruction('', { title: ' ' })], [instruction('', { title: 'x'.repeat(101) })],
    [instruction('', { id: '../test' })], [instruction('', { enabled: 'false' })],
    [instruction('', { targets: { dsh: false, claude: false } })], [instruction('', { targets: { dsh: 'true', claude: false } })]]) {
    await assert.rejects(h.service.update({ customInstructionItems: value, customInstructionItemsBase: [], theme: 'light' }))
  }
  assert.deepEqual(h.events, [])
  const first = h.service.update(instructionPatch('first'))
  const stale = h.service.update(instructionPatch('stale'))
  await first
  await assert.rejects(stale, /別の画面/)
  assert.equal(h.live.customInstructionItems[0].body, 'first')
})

test('manual currency defaults and validation do not infer a USDJPY rate', () => {
  const legacy = migrateSettings({ theme: 'light' })
  assert.equal(legacy.usageCurrency, 'USD')
  assert.equal(legacy.usdJpyRate, null)
  for (const patch of [{ usageCurrency: 'EUR' }, { usageCurrency: 'JPY' },
    ...[0, -1, '150', NaN, Infinity].map((usdJpyRate) => ({ usdJpyRate }))]) {
    assert.throws(() => planSettingsUpdate(defaults(), patch, 1))
  }
  const { settings, effects } = planSettingsUpdate(defaults(), { usageCurrency: 'JPY', usdJpyRate: 150.5 }, 1)
  assert.equal(settings.usageCurrency, 'JPY')
  assert.equal(settings.usdJpyRate, 150.5)
  assert.equal(Object.values(effects).some(Boolean), false)
  assert.throws(() => planSettingsUpdate(settings, { usdJpyRate: null }, 1), /JPY/)
})

test('currency preferences publish only after saving and survive reload without runtime effects', async () => {
  let fail = true
  const h = harness({}, { save: () => { if (fail) throw new Error('disk full') } })
  await assert.rejects(h.service.update({ usageCurrency: 'JPY', usdJpyRate: 150 }), /disk full/)
  assert.equal(h.live.usageCurrency, 'USD')
  assert.equal(h.live.usdJpyRate, null)
  assert.deepEqual(h.events, ['save'])
  fail = false
  await h.service.update({ usageCurrency: 'JPY', usdJpyRate: 150 })
  assert.deepEqual(h.events, ['save', 'save', 'publish'])
  const restored = migrateSettings(JSON.parse(JSON.stringify(h.writes[0])))
  assert.equal(restored.usageCurrency, 'JPY')
  assert.equal(restored.usdJpyRate, 150)
})

test('queued currency changes validate the last committed rate and retain it when returning to USD', async () => {
  const h = harness()
  await Promise.all([h.service.update({ usdJpyRate: 150 }), h.service.update({ usageCurrency: 'JPY' })])
  assert.equal(h.live.usageCurrency, 'JPY')
  await h.service.update({ usageCurrency: 'USD' })
  assert.equal(h.live.usdJpyRate, 150)
  assert.deepEqual(h.events, ['save', 'publish', 'save', 'publish', 'save', 'publish'])
})

test('subagent routes default to each kind itself, migrate from the old per-provider models, merge and validate before committing', async () => {
  const own = { dsh: { target: 'dsh', model: null, effort: null }, cl: { target: 'cl', model: null, effort: null }, gp: { target: 'gp', model: null, effort: null } }
  assert.deepEqual(migrateSettings({}).subagentRoutes, own)
  // A GPT model chosen before the routes existed still serves DSH and Claude Code; a Claude one only DSH.
  const luna = JSON.stringify(['openai-codex', 'gpt-6-luna'])
  const gpt = migrateSettings({ subagentModels: { 'openai-codex': 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' }, subagentEfforts: { 'openai-codex': 'low' } }).subagentRoutes
  assert.deepEqual(gpt.dsh, { target: 'dsh', model: luna, effort: 'low' })
  assert.deepEqual(gpt.cl, gpt.dsh)
  assert.deepEqual(gpt.gp, own.gp)
  assert.deepEqual(migrateSettings({ subagentModels: { anthropic: 'claude-sonnet-5-5' } }).subagentRoutes.dsh.model, JSON.stringify(['anthropic', 'claude-sonnet-5-5']))
  assert.deepEqual(migrateSettings({ subagentModels: { anthropic: 'claude-sonnet-5-5' } }).subagentRoutes.cl, own.cl)
  // Once routes are saved the old keys no longer count; a damaged route falls back to its own kind.
  assert.deepEqual(migrateSettings({ subagentModels: { 'openai-codex': 'gpt-6-luna' }, subagentRoutes: own }).subagentRoutes, own)
  assert.deepEqual(migrateSettings({ subagentRoutes: { ...own, cl: { target: 'nowhere' } } }).subagentRoutes.cl, own.cl)

  const h = harness()
  await Promise.all([
    h.service.update({ subagentRoutes: { dsh: { model: luna, effort: 'low' } } }),
    h.service.update({ subagentRoutes: { cl: { target: 'gp', model: 'codex:gpt-6-luna' } } }),
  ])
  assert.deepEqual(h.live.subagentRoutes.dsh, { target: 'dsh', model: luna, effort: 'low' })
  assert.deepEqual(h.live.subagentRoutes.cl, { target: 'gp', model: 'codex:gpt-6-luna', effort: null })
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(h.live))).subagentRoutes, h.live.subagentRoutes)
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'restart', 'save', 'publish', 'home', 'restart'])
  // Moving a route to another kind drops a model that belonged to the old one.
  await h.service.update({ subagentRoutes: { dsh: { target: 'cl' } } })
  assert.deepEqual(h.live.subagentRoutes.dsh, { target: 'cl', model: null, effort: null })
  for (const bad of [{ target: 'x' }, { target: 'cl', model: luna }, { model: 'claude:sonnet' }, { effort: 7 }, 'text', [], null]) {
    await assert.rejects(h.service.update({ subagentRoutes: { gp: bad } }), /サブエージェント|使えない/)
  }
  for (const value of [null, 1, false, 'text', []]) await assert.rejects(h.service.update({ subagentRoutes: value }), /オブジェクト/)
  assert.deepEqual(h.live.subagentRoutes.gp, own.gp)
})

test('mixed valid/invalid patches have no persistence, publication or effects', async () => {
  const patches = [
    { ...instructionPatch('valid'), dshUpdateChannel: 'invalid' },
    { theme: 'light', usageCurrency: 'JPY' },
    { theme: 'light', usdJpyRate: 0 },
    { contextLimits: { anthropic: 128_000 }, subagentRoutes: { dsh: { target: 'nowhere' } } },
    { subagentRoutes: { cl: { model: 'claude:opus' } }, customInstructionItems: 5, customInstructionItemsBase: [] },
    { fastMode: { anthropic: true }, modelAutoUpdate: 'false' },
    { browserTool: false, defaultPermissionMode: 'invalid' },
    { notifications: true, defaultModel: {} },
  ]
  for (const patch of patches) {
    const h = harness()
    const before = freeze(h.live)
    const input = structuredClone(patch)
    await assert.rejects(h.service.update(patch))
    assert.strictEqual(h.live, before)
    assert.deepEqual(h.events, [])
    assert.deepEqual(patch, input)
  }
})

test('planning is pure and preserves existing settings and partial provider maps', () => {
  const current = freeze(defaults({
    contextLimits: { 'openai-codex': 272_000, anthropic: null },
    subagentRoutes: { dsh: { target: 'dsh', model: JSON.stringify(['openai-codex', 'gpt-custom']), effort: null }, cl: { target: 'cl', model: null, effort: null }, gp: { target: 'gp', model: null, effort: null } },
    customModels: [{ provider: 'anthropic', id: 'custom', template: 'claude-opus-5' }],
    fastModePeriods: { anthropic: [[100, 200]], legacy: [[1, 2]] },
    savedExtension: { keep: true },
  }))
  const patch = freeze({
    contextLimits: { anthropic: 200_000, unsupported: 'ignored' },
    subagentRoutes: { cl: { model: 'claude:custom' } },
    fastMode: { anthropic: true, unsupported: 'ignored' },
    ...instructionPatch('  日本語で\n{{model}}  '),
    customModels: [],
    remoteAccess: true,
    ignored: 'field',
  })
  const a = planSettingsUpdate(current, patch, 300)
  assert.deepEqual(a, planSettingsUpdate(current, patch, 300))
  assert.notStrictEqual(a.settings, current)
  assert.deepEqual(a.settings.contextLimits, { 'openai-codex': 272_000, anthropic: 200_000 })
  assert.deepEqual(a.settings.subagentRoutes, { dsh: current.subagentRoutes.dsh, cl: { target: 'cl', model: 'claude:custom', effort: null }, gp: current.subagentRoutes.gp })
  assert.deepEqual(a.settings.fastMode, { 'openai-codex': false, anthropic: true })
  assert.deepEqual(a.settings.fastModePeriods, { anthropic: [[100, 200], [300, null]], legacy: [[1, 2]] })
  assert.deepEqual(a.settings.customInstructionItems, patch.customInstructionItems)
  assert.deepEqual(a.settings.customModels, current.customModels)
  assert.equal(a.settings.remoteAccess, false)
  assert.deepEqual(a.settings.savedExtension, { keep: true })
  assert.equal(a.settings.ignored, undefined)
  assert.deepEqual(current.fastModePeriods.anthropic, [[100, 200]])
})

test('save failure leaves live settings and fast periods untouched, then the queue recovers', async () => {
  let fail = true
  const h = harness({ fastModePeriods: { anthropic: [[1, 2]] } }, {
    save: () => { if (fail) throw new Error('disk full') },
  })
  const before = freeze(h.live)
  await assert.rejects(h.service.update({
    contextLimits: { anthropic: 128_000 },
    ...instructionPatch('not committed'),
    fastMode: { anthropic: true },
    browserTool: false,
    modelAutoUpdate: false,
  }), /disk full/)
  assert.strictEqual(h.live, before)
  assert.deepEqual(h.events, ['save'])
  assert.deepEqual(h.writes, [])
  fail = false
  await h.service.update({ theme: 'light' })
  assert.equal(h.live.theme, 'light')
  assert.deepEqual(h.live.customInstructionItems, [])
  assert.equal(h.live.fastMode.anthropic, false)
  assert.deepEqual(h.live.fastModePeriods.anthropic, [[1, 2]])
  assert.deepEqual(h.events, ['save', 'save', 'publish'])
})

test('compound changes save, publish, patch and restart once, after persistence', async () => {
  const h = harness({ modelAutoUpdate: false }, {
    fast: (live) => assert.equal(live.customInstructionItems[0]?.body, 'committed'),
    catalog: (live) => {
      assert.equal(live.modelAutoUpdate, true)
      return { restartRequired: true }
    },
  })
  const result = await h.service.update({
    contextLimits: { anthropic: 200_000 },
    subagentRoutes: { gp: { model: 'codex:gpt-custom' } },
    ...instructionPatch('committed'),
    fastMode: { anthropic: true },
    browserHeadless: true,
    browserTool: false,
    desktopTool: true,
    imageTool: false,
    modelAutoUpdate: true,
    dshUpdateChannel: 'next',
  })
  assert.deepEqual(h.events, ['save', 'publish', 'fast', 'catalog', 'home', 'restart', 'channel', 'model-check'])
  assert.strictEqual(result.settings, h.live)
  assert.strictEqual(result.settings, h.writes[0])
  assert.equal(h.published.length, 1)
  assert.deepEqual(h.live.fastModePeriods.anthropic, [[1234, null]])
})

test('live state remains unchanged until a delayed save succeeds', async () => {
  const started = deferred()
  const finish = deferred()
  const h = harness({}, { save: async () => { started.resolve(); await finish.promise } })
  const before = h.live
  const request = h.service.update({ ...instructionPatch('later') })
  await started.promise
  assert.strictEqual(h.live, before)
  assert.deepEqual(h.live.customInstructionItems, [])
  assert.deepEqual(h.events, ['save'])
  finish.resolve()
  await request
  assert.equal(h.live.customInstructionItems[0]?.body, 'later')
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'restart'])
})

test('concurrent updates plan from the last commit, capture patches and preserve both providers', async () => {
  const started = deferred()
  const finish = deferred()
  let first = true
  const h = harness({}, {
    save: async () => {
      if (!first) return
      first = false
      started.resolve()
      await finish.promise
    },
  })
  const a = h.service.update({ contextLimits: { anthropic: 200_000 }, ...instructionPatch('first') })
  await started.promise
  const patch = { contextLimits: { 'openai-codex': 400_000 }, theme: 'light' }
  const b = h.service.update(patch)
  patch.contextLimits['openai-codex'] = 64_000
  patch.theme = 'dark'
  assert.deepEqual(h.events, ['save'])
  finish.resolve()
  const [one, two] = await Promise.all([a, b])
  assert.equal(one.settings.theme, 'dark')
  assert.equal(two.settings.theme, 'light')
  assert.equal(h.live.customInstructionItems[0]?.body, 'first')
  assert.deepEqual(h.live.contextLimits, { anthropic: 200_000, 'openai-codex': 400_000 })
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'restart', 'save', 'publish', 'home', 'restart'])
  assert.deepEqual(h.writes[1], h.live)
})

test('mutate waits for a pending update and persists a draft of the latest snapshot', async () => {
  const saving = deferred()
  const finishSave = deferred()
  const h = harness({}, { save: async () => { saving.resolve(); await finishSave.promise } })
  const before = h.live
  const update = h.service.update({ theme: 'light' })
  await saving.promise
  const mutation = h.service.mutate(candidate => {
    h.events.push('other-mutation')
    assert.notStrictEqual(candidate, before)
    assert.notStrictEqual(candidate, h.live)
    assert.equal(candidate.theme, 'light')
    candidate.workspaces = ['F:\\workspace']
    candidate.lastWorkspace = 'F:\\workspace'
  })
  await Promise.resolve()
  assert.deepEqual(h.events, ['save'])
  assert.deepEqual(h.live.workspaces, [])
  finishSave.resolve()
  const [, result] = await Promise.all([update, mutation])
  assert.strictEqual(result.settings, h.live)
  assert.equal(h.live.theme, 'light')
  assert.deepEqual(h.live.workspaces, ['F:\\workspace'])
  assert.equal(h.live.lastWorkspace, 'F:\\workspace')
  assert.deepEqual(h.events, ['save', 'publish', 'other-mutation', 'save', 'publish'])
})

test('update waits for a running mutator and plans from all its final changes', async () => {
  const started = deferred()
  const finishMutation = deferred()
  const h = harness()
  const mutation = h.service.mutate(async candidate => {
    h.events.push('other-start')
    started.resolve()
    await finishMutation.promise
    candidate.workspaces = ['F:\\workspace']
    candidate.lastWorkspace = 'F:\\workspace'
    candidate.projectNames = { 'F:\\workspace': 'Custom project' }
    h.events.push('other-finish')
  })
  await started.promise
  const update = h.service.update({ theme: 'light' })
  await Promise.resolve()
  assert.deepEqual(h.events, ['other-start'])
  assert.equal(h.live.theme, 'dark')
  finishMutation.resolve()
  await Promise.all([mutation, update])
  assert.equal(h.live.theme, 'light')
  assert.deepEqual(h.live.workspaces, ['F:\\workspace'])
  assert.equal(h.live.lastWorkspace, 'F:\\workspace')
  assert.deepEqual(h.live.projectNames, { 'F:\\workspace': 'Custom project' })
  assert.deepEqual(h.writes.at(-1), h.live)
  assert.deepEqual(h.events, ['other-start', 'other-finish', 'save', 'publish', 'save', 'publish'])
})

test('failed mutation work rejects its caller without poisoning mutate or update', async () => {
  const h = harness()
  const failure = h.service.mutate(candidate => {
    candidate.notifications = false
    throw new Error('other mutation failed')
  })
  const next = h.service.mutate(candidate => { candidate.notifications = false })
  const update = h.service.update({ theme: 'light' })
  await assert.rejects(failure, /other mutation failed/)
  assert.equal((await next).settings.notifications, false)
  await update
  assert.equal(h.live.notifications, false)
  assert.equal(h.live.theme, 'light')
  assert.deepEqual(h.events, ['save', 'publish', 'save', 'publish'])
})

test('the queue includes runtime effects, not just disk writes', async () => {
  const restarting = deferred()
  const finish = deferred()
  const h = harness({}, { restart: async () => { restarting.resolve(); await finish.promise } })
  const first = h.service.update({ browserTool: false })
  await restarting.promise
  const second = h.service.update({ theme: 'light' })
  await Promise.resolve()
  assert.deepEqual(h.events, ['save', 'publish', 'restart'])
  assert.equal(h.live.theme, 'dark')
  finish.resolve()
  await Promise.all([first, second])
  assert.deepEqual(h.events, ['save', 'publish', 'restart', 'save', 'publish'])
  assert.equal(h.live.browserTool, false)
})

test('a failed queued request does not drop a following valid update', async () => {
  const h = harness()
  const invalid = h.service.update({ ...instructionPatch('bad'), notifications: 'false' })
  const valid = h.service.update({ ...instructionPatch('good') })
  await assert.rejects(invalid, /boolean/)
  await valid
  assert.equal(h.live.customInstructionItems[0]?.body, 'good')
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'restart'])
})

test('boolean settings and provider toggles reject coercion', async () => {
  const keys = ['notifications', 'browserTool', 'browserHeadless', 'desktopTool', 'imageTool', 'checkpoints', 'modelAutoUpdate', 'claudeCodeMode']
  for (const key of keys) {
    for (const value of ['false', 0, 1, null, undefined, {}, []]) {
      const h = harness()
      await assert.rejects(h.service.update({ [key]: value }), /boolean/)
      assert.deepEqual(h.events, [], `${key}: ${String(value)}`)
    }
    for (const value of [true, false]) assert.equal(planSettingsUpdate(defaults(), { [key]: value }, 0).settings[key], value)
  }
  for (const provider of ['anthropic', 'openai-codex']) {
    for (const value of ['true', 1, null, {}, []]) {
      assert.throws(() => planSettingsUpdate(defaults(), { fastMode: { [provider]: value } }, 0), /boolean/)
    }
  }
})

test('enum and string settings validate types without restricting opaque custom defaults', async () => {
  const choices = {
    theme: ['system', 'light', 'dark'],
    browserBackend: ['chrome', 'browser-use'],
    defaultPermissionMode: ['read-only', 'workspace-write', 'danger-full-access'],
    dshUpdateChannel: ['latest', 'next', 'alpha'],
  }
  for (const [key, values] of Object.entries(choices)) {
    for (const value of values) assert.equal(planSettingsUpdate(defaults(), { [key]: value }, 0).settings[key], value)
    for (const value of ['invalid', true, 0, null, [], {}]) {
      const h = harness()
      await assert.rejects(h.service.update({ [key]: value }))
      assert.deepEqual(h.events, [])
    }
  }
  for (const key of ['defaultModel', 'lastWorkspace', 'defaultEffort']) {
    for (const value of [1, false, {}, [], undefined]) {
      assert.throws(() => planSettingsUpdate(defaults(), { [key]: value }, 0), /文字列/)
    }
  }
  assert.throws(() => planSettingsUpdate(defaults(), { defaultEffort: null }, 0), /文字列/)
  const custom = JSON.stringify({ provider: 'anthropic', model: 'my-custom-model' })
  const h = harness()
  await h.service.update({ defaultModel: custom, defaultEffort: 'future-effort', lastWorkspace: 'F:\\custom' })
  assert.equal(h.live.defaultModel, custom)
  assert.equal(h.live.defaultEffort, 'future-effort')
  await h.service.update({ defaultModel: null, lastWorkspace: null })
  assert.equal(h.live.defaultModel, null)
  assert.equal(h.live.lastWorkspace, null)
})

test('browser selection keeps the Chrome default and recycles the runtime on change', () => {
  const before = migrateSettings({ browserTool: false })
  assert.equal(before.browserBackend, 'chrome')
  assert.equal(before.browserTool, false)
  const change = planSettingsUpdate(before, { browserBackend: 'browser-use' }, 0)
  assert.equal(change.effects.restart, true)
  assert.equal(migrateSettings(change.settings).browserBackend, 'browser-use')
  assert.equal(planSettingsUpdate(change.settings, { browserBackend: 'browser-use' }, 0).effects.restart, false)
})

test('patch/maps, context choices, model IDs and instruction length are validated', async () => {
  for (const patch of [null, undefined, true, 2, 'text', [], new Date()]) {
    const h = harness()
    await assert.rejects(h.service.update(patch), /オブジェクト/)
    assert.deepEqual(h.events, [])
  }
  for (const field of ['contextLimits', 'subagentRoutes', 'fastMode']) {
    for (const value of [null, 1, false, 'text', [], new Date()]) {
      assert.throws(() => planSettingsUpdate(defaults(), { [field]: value }, 0), /オブジェクト/)
    }
  }
  for (const value of [64_000, 128_000, 200_000, 272_000, 400_000, 500_000, 1_000_000, null]) {
    assert.equal(planSettingsUpdate(defaults(), { contextLimits: { anthropic: value } }, 0).settings.contextLimits.anthropic, value)
  }
  for (const value of ['128000', 42, true, undefined]) {
    assert.throws(() => planSettingsUpdate(defaults(), { contextLimits: { anthropic: value } }, 0), /コンテキスト/)
  }
  for (const value of [42, '', 'spaces not allowed', 'x'.repeat(1001), {}, false, 'claude:bad id']) {
    assert.throws(() => planSettingsUpdate(defaults(), { subagentRoutes: { cl: { model: value } } }, 0), /モデル/)
  }
  assert.equal(planSettingsUpdate(defaults(), { subagentRoutes: { cl: { model: null } } }, 0).settings.subagentRoutes.cl.model, null)
  const items = [instruction('x'.repeat(5_000)), instruction('y'.repeat(5_000), { id: 'off', enabled: false })]
  const patch = { customInstructionItems: items, customInstructionItemsBase: [] }
  assert.deepEqual(planSettingsUpdate(defaults(), patch, 0).settings.customInstructionItems, items)
  items[1].body += 'z'
  assert.throws(() => planSettingsUpdate(defaults(), patch, 0), /文字まで/)
})

test('fast mode records opening and closing exactly once without restarting runtimes', async () => {
  let now = 100
  const h = harness({}, { now: () => now })
  await h.service.update({ fastMode: { anthropic: true } })
  const opened = h.live
  now = 200
  await h.service.update({ fastMode: { anthropic: true } })
  now = 300
  await h.service.update({ fastMode: { 'openai-codex': false } })
  now = 400
  await h.service.update({ fastMode: { anthropic: false } })
  now = 500
  await h.service.update({ fastMode: { anthropic: false } })
  now = 600
  await h.service.update({ fastMode: { anthropic: true } })
  assert.deepEqual(opened.fastModePeriods.anthropic, [[100, null]])
  assert.deepEqual(h.live.fastModePeriods.anthropic, [[100, 400], [600, null]])
  assert.equal(h.live.fastMode['openai-codex'], false)
  assert.deepEqual(h.events, Array.from({ length: 6 }, () => ['save', 'publish', 'fast']).flat())
})

test('unchanged toggles avoid checks/restarts and home patch content controls restarting', async () => {
  const h = harness({}, { home: () => false })
  await h.service.update({ browserTool: true, modelAutoUpdate: true, dshUpdateChannel: 'latest', customInstructionItems: [], customInstructionItemsBase: [] })
  assert.deepEqual(h.events, ['save', 'publish'])
  await h.service.update({ theme: 'light', notifications: false, checkpoints: false })
  assert.deepEqual(h.events.slice(2), ['save', 'publish'])
})

test('catalog toggles combine restart reasons and only enabling checks for new models', async () => {
  const off = harness({}, { home: () => false })
  await off.service.update({ modelAutoUpdate: false, browserTool: false })
  assert.deepEqual(off.events, ['save', 'publish', 'catalog', 'home', 'restart'])
  const unchangedCatalog = harness({}, { catalog: () => ({ restartRequired: false }), home: () => false })
  await unchangedCatalog.service.update({ modelAutoUpdate: false })
  assert.deepEqual(unchangedCatalog.events, ['save', 'publish', 'catalog', 'home'])
  const patched = harness({}, { catalog: () => ({ restartRequired: false }) })
  await patched.service.update({ modelAutoUpdate: false })
  assert.deepEqual(patched.events, ['save', 'publish', 'catalog', 'home', 'restart'])
})

test('the persisted decorated snapshot is the one published and returned', async () => {
  const h = harness({}, { decorate: (candidate) => ({ ...candidate, projectColors: { 'F:\\work': 2 } }) })
  const result = await h.service.update({ theme: 'light' })
  assert.strictEqual(result.settings, h.writes[0])
  assert.strictEqual(result.settings, h.published[0])
  assert.deepEqual(h.live.projectColors, { 'F:\\work': 2 })
})

test('old saved values and unknown fields are retained without migration', async () => {
  const h = harness({ defaultEffort: '', modelAutoUpdate: null, savedExtension: [1, 2] })
  await h.service.update({ modelAutoUpdate: true, unknown: true })
  assert.equal(h.live.defaultEffort, '')
  assert.deepEqual(h.live.savedExtension, [1, 2])
  assert.deepEqual(h.events, ['save', 'publish'])
})

test('effect failure retains the saved commit and retries with a later update', async () => {
  let fail = true
  const h = harness({}, { home: () => { if (fail) throw new Error('home patch unavailable'); return true } })
  await assert.rejects(h.service.update({ ...instructionPatch('already saved') }), error => {
    assert.equal(error.settingsCommitted, true)
    return /home patch unavailable/.test(error.message)
  })
  assert.equal(h.live.customInstructionItems[0]?.body, 'already saved')
  assert.deepEqual(h.events, ['save', 'publish', 'home'])
  fail = false
  await h.service.update({ theme: 'light' })
  assert.equal(h.live.customInstructionItems[0]?.body, 'already saved')
  assert.equal(h.live.theme, 'light')
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'save', 'publish', 'home', 'restart'])
})

test('same-value update retries a failed subagent home patch, but not after recovery', async () => {
  let fail = true
  let applied = true
  const h = harness({}, { home: live => {
    if (fail) throw new Error('home patch unavailable')
    applied = live.subagentsEnabled
    return true
  } })
  await assert.rejects(h.service.update({ subagentsEnabled: false }), error => error.settingsCommitted === true)
  assert.equal(h.live.subagentsEnabled, false)
  assert.equal(applied, true)
  fail = false
  await h.service.update({ subagentsEnabled: false })
  assert.equal(applied, false)
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'save', 'publish', 'home', 'restart'])
  await h.service.update({ subagentsEnabled: false })
  assert.deepEqual(h.events.slice(-2), ['save', 'publish'])
})

test('a queued update retries the failed home patch with the latest committed settings', async () => {
  const started = deferred()
  const release = deferred()
  let calls = 0
  let applied = null
  const h = harness({}, { home: async live => {
    calls++
    if (calls === 1) {
      started.resolve()
      await release.promise
      throw new Error('home patch unavailable')
    }
    applied = { subagentsEnabled: live.subagentsEnabled, theme: live.theme }
    return true
  } })
  const first = h.service.update({ subagentsEnabled: false })
  await started.promise
  const second = h.service.update({ subagentsEnabled: true, theme: 'light' })
  assert.deepEqual(h.events, ['save', 'publish', 'home'])
  release.resolve()
  await assert.rejects(first, error => error.settingsCommitted === true)
  await second
  assert.deepEqual(applied, { subagentsEnabled: true, theme: 'light' })
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'save', 'publish', 'home', 'restart'])
})

test('retry after partial home patch failure still restarts when the patch now reports unchanged', async () => {
  let patch = true
  let fail = true
  const h = harness({}, { home: live => {
    const changed = patch !== live.subagentsEnabled
    patch = live.subagentsEnabled
    if (fail) throw new Error('second patch file unavailable')
    return changed
  } })
  await assert.rejects(h.service.update({ subagentsEnabled: false }), /second patch file unavailable/)
  assert.equal(patch, false)
  fail = false
  await h.service.update({ subagentsEnabled: false })
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'save', 'publish', 'home', 'restart'])
})

test('retry preserves a restart that failed after the patch was already written', async () => {
  let patch = true
  let fail = true
  const h = harness({}, {
    home: live => { const changed = patch !== live.subagentsEnabled; patch = live.subagentsEnabled; return changed },
    restart: () => { if (fail) throw new Error('restart unavailable') },
  })
  await assert.rejects(h.service.update({ subagentsEnabled: false }), /restart unavailable/)
  assert.equal(patch, false)
  fail = false
  await h.service.update({ subagentsEnabled: false })
  assert.equal(h.events.filter(event => event === 'restart').length, 2)
})

test('save failure does not schedule effects and does not discard an earlier pending effect', async () => {
  let failHome = true
  let failSave = false
  const h = harness({}, {
    home: () => { if (failHome) throw new Error('home unavailable'); return true },
    save: () => { if (failSave) throw new Error('disk full') },
  })
  await assert.rejects(h.service.update({ subagentsEnabled: false }), error => error.settingsCommitted === true)
  failSave = true
  await assert.rejects(h.service.update({ theme: 'light' }), error => error.settingsCommitted !== true && /disk full/.test(error.message))
  assert.equal(h.live.theme, 'dark')
  failHome = false
  failSave = false
  await h.service.update({ theme: 'light' })
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'save', 'save', 'publish', 'home', 'restart'])
})

test('a failed early effect leaves later effects pending and retries only the latest settings', async () => {
  let fail = true
  let fastApplied = null
  let catalogAutoUpdate = null
  const h = harness({ modelAutoUpdate: false }, {
    fast: live => { if (fail) throw new Error('fast state unavailable'); fastApplied = live.fastMode.anthropic },
    catalog: live => { catalogAutoUpdate = live.modelAutoUpdate; return { restartRequired: false } },
    home: () => false,
  })
  await assert.rejects(h.service.update({
    fastMode: { anthropic: true }, modelAutoUpdate: true, dshUpdateChannel: 'next',
  }), error => error.settingsCommitted === true)
  assert.deepEqual(h.events, ['save', 'publish', 'fast'])
  fail = false
  await h.service.update({ fastMode: { anthropic: false }, modelAutoUpdate: false })
  assert.equal(fastApplied, false)
  assert.equal(catalogAutoUpdate, false)
  assert.deepEqual(h.events, ['save', 'publish', 'fast', 'save', 'publish', 'fast', 'catalog', 'home', 'channel'])
})

test('model visibility merges queued per-model changes, persists and publishes without runtime effects', async () => {
  const terra = '["openai-codex","gpt-5.6-terra"]'
  const claude = '["anthropic","claude-sonnet-5-5"]'
  const started = deferred()
  const finish = deferred()
  let first = true
  const h = harness({ defaultModel: terra }, {
    save: async () => {
      if (!first) return
      first = false
      started.resolve()
      await finish.promise
    },
  })
  const a = h.service.update({ modelVisibility: { [terra]: false } })
  await started.promise
  assert.deepEqual(h.live.modelVisibility, {})
  const b = h.service.update({ modelVisibility: { [claude]: false } })
  finish.resolve()
  await Promise.all([a, b])
  assert.deepEqual(h.live.modelVisibility, { [terra]: false, [claude]: false })
  await h.service.update({ modelVisibility: { [terra]: true } })
  assert.deepEqual(h.live.modelVisibility, { [terra]: true, [claude]: false })
  assert.deepEqual(h.writes.at(-1).modelVisibility, h.live.modelVisibility)
  assert.equal(h.live.defaultModel, terra)
  assert.deepEqual(h.events, ['save', 'publish', 'save', 'publish', 'save', 'publish'])
})

test('model visibility validates the entire patch without effects and supports opaque ACP values', async () => {
  for (const value of [null, [], 'text', false, 1, new Date()]) {
    const h = harness()
    await assert.rejects(h.service.update({ theme: 'light', modelVisibility: value }), /オブジェクト/)
    assert.deepEqual(h.events, [])
  }
  for (const value of [null, undefined, 'false', 0, {}, []]) {
    const h = harness()
    await assert.rejects(h.service.update({ modelVisibility: { valid: false, invalid: value } }), /boolean/)
    assert.deepEqual(h.events, [])
  }
  assert.throws(() => planSettingsUpdate(defaults(), { modelVisibility: { ' ': false } }, 0), /空/)
  const current = freeze(defaults({ modelVisibility: { existing: false } }))
  const patch = freeze({ modelVisibility: { '{"provider":"future","model":"custom"}': false } })
  const planned = planSettingsUpdate(current, patch, 0)
  assert.deepEqual(planned.settings.modelVisibility, { existing: false, ...patch.modelVisibility })
  assert.deepEqual(current.modelVisibility, { existing: false })
  const legacy = defaults()
  delete legacy.modelVisibility
  assert.deepEqual(planSettingsUpdate(legacy, patch, 0).settings.modelVisibility, patch.modelVisibility)
})

test('model visibility save failures leave all choices unchanged', async () => {
  const h = harness({ modelVisibility: { retained: false } }, { save: () => { throw new Error('disk full') } })
  await assert.rejects(h.service.update({ modelVisibility: { retained: true, other: false } }), /disk full/)
  assert.deepEqual(h.live.modelVisibility, { retained: false })
  assert.deepEqual(h.events, ['save'])
})

test('background checks do not block later updates and failures are reported', async () => {
  const check = deferred()
  const h = harness({}, { modelCheck: () => check.promise.then(() => { throw new Error('offline') }) })
  await h.service.update({ modelAutoUpdate: false })
  await h.service.update({ modelAutoUpdate: true })
  await h.service.update({ notifications: false })
  assert.equal(h.live.notifications, false)
  check.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(h.events.includes('background-error:offline'))
})

test('each mode\'s harnesses save as written; only a TM or eco child one rewrites the children\'s layers', async () => {
  const h = harness()
  for (const key of ['tmParentHarness', 'tmChildHarness', 'ecoParentHarness', 'ecoChildHarness', 'abParentHarness', 'abChildHarness']) assert.equal(h.live[key], '')
  await h.service.update({ tmParentHarness: '  親の規則\n', ecoParentHarness: 'eco親', abParentHarness: 'AB親' })
  assert.equal(h.live.tmParentHarness, '  親の規則\n')
  assert.equal(h.live.ecoParentHarness, 'eco親')
  assert.ok(!h.events.some((event) => ['home', 'team-child', 'restart'].includes(event)), 'leaders read the parent harness at launch')
  await h.service.update({ abChildHarness: 'AB子' })
  assert.ok(!h.events.includes('team-child'), 'AB reads its child harness as each stage starts')
  await h.service.update({ ecoChildHarness: '子の規則' })
  assert.equal(h.live.ecoChildHarness, '子の規則')
  assert.equal(h.live.tmChildHarness, '', 'modes do not share a harness')
  assert.ok(h.events.includes('team-child'), 'dsh children read it from their layer')
  assert.ok(!h.events.some((event) => ['home', 'restart'].includes(event)), 'other runtimes are not recycled')
  const before = h.events.length
  await h.service.update({ ecoChildHarness: '子の規則' })
  assert.ok(!h.events.slice(before).includes('team-child'), 'an unchanged harness rewrites nothing')
  for (const [patch, error] of [
    [{ tmParentHarness: 1 }, /TMの親ハーネスは文字列/],
    [{ ecoChildHarness: 'x'.repeat(2_001) }, /ecoの子ハーネスは 2,000 文字まで/],
    [{ abParentHarness: 'x'.repeat(4_001) }, /ABの親ハーネスは 4,000 文字まで/],
  ]) await assert.rejects(h.service.update({ theme: 'light', ...patch }), error)
  await h.service.update({ tmChildHarness: 'x'.repeat(2_000), tmParentHarness: 'x'.repeat(4_000) })
  assert.equal(h.live.theme, 'dark', 'an invalid harness rejects the entire patch')
  assert.equal(h.live.tmChildHarness.length, 2_000)
})

test('a switched-off harness keeps its text but is not read; a TM or eco child switch rewrites the children\'s layers', async () => {
  const h = harness({ tmChildHarness: '子の規則', abChildHarness: 'AB子', tmParentHarness: '親の規則' })
  assert.equal(effectiveHarness(h.live, 'tm', 'child'), '子の規則', 'older saves have no switch and count as on')
  await h.service.update({ tmChildHarnessEnabled: false })
  assert.equal(h.live.tmChildHarness, '子の規則')
  assert.equal(effectiveHarness(h.live, 'tm', 'child'), '')
  assert.ok(h.events.includes('team-child'))
  const before = h.events.length
  await h.service.update({ abChildHarnessEnabled: false, tmParentHarnessEnabled: false, tmChildHarness: '書き換え' })
  assert.ok(!h.events.slice(before).includes('team-child'), 'AB, parents and the text of an off harness touch no layer')
  assert.equal(effectiveHarness(h.live, 'ab', 'child'), '')
  assert.equal(effectiveHarness(h.live, 'tm', 'parent'), '')
  await h.service.update({ tmChildHarnessEnabled: true })
  assert.equal(effectiveHarness(h.live, 'tm', 'child'), '書き換え')
  assert.ok(h.events.slice(before).includes('team-child'))
  await assert.rejects(h.service.update({ ecoParentHarnessEnabled: 'false' }), /boolean/)
})

test('the shared harnesses of an earlier save start every mode', () => {
  const saved = { teamParentHarness: '共通の親', teamChildHarness: '共通の子', teamPolicies: [{ id: 'p1', name: 'A', text: '方針' }] }
  const migrated = migrateSettings(saved)
  for (const mode of ['tm', 'eco', 'ab']) {
    assert.equal(migrated[`${mode}ParentHarness`], '共通の親')
    assert.equal(migrated[`${mode}ChildHarness`], '共通の子')
  }
  assert.equal(migrated.teamParentHarness, '共通の親', 'the old fields stay in the file')
  // Once a mode's own harness is saved (even empty), the shared one is no longer read for it.
  assert.equal(migrateSettings({ ...saved, ecoChildHarness: '' }).ecoChildHarness, '')
  assert.equal(DEFAULT_SETTINGS.teamParentHarness, undefined)
})

test('the removed TM-only 方針 and プレイブック become TM\'s parent harness, and their saved fields are kept', () => {
  const one = { teamPolicies: [{ id: 'p1', name: '使い分け', text: ' 設計は Claude ' }], teamPlaybooks: [] }
  assert.equal(migrateSettings(one).tmParentHarness, '設計は Claude')
  assert.equal(migrateSettings(one).ecoParentHarness, '')
  assert.equal(migrateSettings(one).abParentHarness, '')
  assert.deepEqual(migrateSettings(one).teamPolicies, one.teamPolicies)
  const many = migrateSettings({
    teamPolicies: [{ id: 'p1', name: 'A', text: 'a' }, { id: 'p2', name: 'B', text: '' }],
    teamPlaybooks: [{ id: 'b1', name: '大改修', description: '大きな改修', body: '手順' }, { id: 'b2', name: '空', description: '', body: ' ' }],
  })
  assert.equal(many.tmParentHarness, '## A\na\n\n## 大改修（大きな改修）\n手順')
  assert.equal(migrateSettings({}).tmParentHarness, '')
  // Once a harness is saved (even empty), the old fields are no longer read.
  assert.equal(migrateSettings({ ...one, teamParentHarness: '' }).tmParentHarness, '')
  assert.equal(migrateSettings({ ...one, tmParentHarness: '' }).tmParentHarness, '')
  assert.equal(DEFAULT_SETTINGS.teamPolicies, undefined)
})

test('agent team settings merge per field, validate everything and need no runtime effects', async () => {
  const h = harness()
  await h.service.update({ agentTeams: { gpt: { low: { model: 'gpt-5.6-luna' } }, claude: { mid: { effort: 'high' } }, maxChildren: 3 } })
  assert.equal(h.live.agentTeams.gpt.low.model, 'gpt-5.6-luna')
  assert.equal(h.live.agentTeams.gpt.low.effort, 'medium')
  assert.equal(h.live.agentTeams.claude.mid.model, 'sonnet')
  assert.equal(h.live.agentTeams.claude.mid.effort, 'high')
  assert.equal(h.live.agentTeams.maxChildren, 3)
  assert.deepEqual(h.events, ['save', 'publish'])
  for (const patch of [
    null, [], { leader: 'opus' }, { leader: { model: 'bad model' } }, { leaderBypass: 'yes' },
    { gpt: { enabled: 1 } }, { gpt: { low: { model: 'a b' } } }, { claude: { mid: { effort: 'HIGH!' } } },
    { maxChildren: 0 }, { maxChildren: MAX_CHILDREN_LIMIT + 1 }, { maxChildren: 2.5 },
    { gpt: { enabled: true, low: { enabled: false }, mid: { enabled: false } } },
  ]) {
    const before = structuredClone(h.live)
    await assert.rejects(h.service.update({ theme: 'light', agentTeams: patch }))
    assert.deepEqual(h.live, before)
  }
  const cleared = planSettingsUpdate(h.live, { agentTeams: { gpt: { low: { model: null } }, leader: { effort: null } } }, 0)
  assert.equal(cleared.settings.agentTeams.gpt.low.model, null)
  const legacy = defaults()
  delete legacy.agentTeams
  // Every kind of child starts off, and the saved settings may leave them all off (a team asks for one).
  const fresh = planSettingsUpdate(legacy, { agentTeams: { claude: { low: { model: 'haiku' } } } }, 0).settings.agentTeams
  assert.deepEqual(['gpt', 'claude', 'claudeApi', 'deepseek'].map((provider) => fresh[provider].enabled), [false, false, false, false])
  assert.equal(planSettingsUpdate(legacy, { agentTeams: { claude: { enabled: true } } }, 0).settings.agentTeams.claude.enabled, true)
})
