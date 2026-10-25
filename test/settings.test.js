import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSettingsService, DEFAULT_SETTINGS, planSettingsUpdate } from '../server/settings.js'

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

test('mixed valid/invalid patches have no persistence, publication or effects', async () => {
  const patches = [
    { customInstructions: 'valid', dshUpdateChannel: 'invalid' },
    { contextLimits: { anthropic: 128_000 }, subagentModels: { anthropic: 123 } },
    { subagentModels: { anthropic: 'claude-opus-5' }, customInstructions: 5 },
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
    subagentModels: { 'openai-codex': 'gpt-custom' },
    customModels: [{ provider: 'anthropic', id: 'custom', template: 'claude-opus-5' }],
    fastModePeriods: { anthropic: [[100, 200]], legacy: [[1, 2]] },
    savedExtension: { keep: true },
  }))
  const patch = freeze({
    contextLimits: { anthropic: 200_000, unsupported: 'ignored' },
    subagentModels: { anthropic: 'claude-custom' },
    fastMode: { anthropic: true, unsupported: 'ignored' },
    customInstructions: '  日本語で\n{{model}}  ',
    customModels: [],
    remoteAccess: true,
    ignored: 'field',
  })
  const a = planSettingsUpdate(current, patch, 300)
  assert.deepEqual(a, planSettingsUpdate(current, patch, 300))
  assert.notStrictEqual(a.settings, current)
  assert.deepEqual(a.settings.contextLimits, { 'openai-codex': 272_000, anthropic: 200_000 })
  assert.deepEqual(a.settings.subagentModels, { 'openai-codex': 'gpt-custom', anthropic: 'claude-custom' })
  assert.deepEqual(a.settings.fastMode, { 'openai-codex': false, anthropic: true })
  assert.deepEqual(a.settings.fastModePeriods, { anthropic: [[100, 200], [300, null]], legacy: [[1, 2]] })
  assert.equal(a.settings.customInstructions, patch.customInstructions)
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
    customInstructions: 'not committed',
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
  assert.equal(h.live.customInstructions, '')
  assert.equal(h.live.fastMode.anthropic, false)
  assert.deepEqual(h.live.fastModePeriods.anthropic, [[1, 2]])
  assert.deepEqual(h.events, ['save', 'save', 'publish'])
})

test('compound changes save, publish, patch and restart once, after persistence', async () => {
  const h = harness({ modelAutoUpdate: false }, {
    fast: (live) => assert.equal(live.customInstructions, 'committed'),
    catalog: (live) => {
      assert.equal(live.modelAutoUpdate, true)
      return { restartRequired: true }
    },
  })
  const result = await h.service.update({
    contextLimits: { anthropic: 200_000 },
    subagentModels: { 'openai-codex': 'gpt-custom' },
    customInstructions: 'committed',
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
  const request = h.service.update({ customInstructions: 'later' })
  await started.promise
  assert.strictEqual(h.live, before)
  assert.equal(h.live.customInstructions, '')
  assert.deepEqual(h.events, ['save'])
  finish.resolve()
  await request
  assert.equal(h.live.customInstructions, 'later')
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
  const a = h.service.update({ contextLimits: { anthropic: 200_000 }, customInstructions: 'first' })
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
  assert.equal(h.live.customInstructions, 'first')
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
  const invalid = h.service.update({ customInstructions: 'bad', notifications: 'false' })
  const valid = h.service.update({ customInstructions: 'good' })
  await assert.rejects(invalid, /boolean/)
  await valid
  assert.equal(h.live.customInstructions, 'good')
  assert.deepEqual(h.events, ['save', 'publish', 'home', 'restart'])
})

test('boolean settings and provider toggles reject coercion', async () => {
  const keys = ['notifications', 'browserTool', 'browserHeadless', 'desktopTool', 'imageTool', 'checkpoints', 'modelAutoUpdate']
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
  for (const key of ['defaultModel', 'lastWorkspace', 'defaultEffort', 'customInstructions']) {
    for (const value of [1, false, {}, [], undefined]) {
      assert.throws(() => planSettingsUpdate(defaults(), { [key]: value }, 0), /文字列/)
    }
  }
  assert.throws(() => planSettingsUpdate(defaults(), { defaultEffort: null }, 0), /文字列/)
  assert.throws(() => planSettingsUpdate(defaults(), { customInstructions: null }, 0), /文字列/)
  const custom = JSON.stringify({ provider: 'anthropic', model: 'my-custom-model' })
  const h = harness()
  await h.service.update({ defaultModel: custom, defaultEffort: 'future-effort', lastWorkspace: 'F:\\custom', customInstructions: '' })
  assert.equal(h.live.defaultModel, custom)
  assert.equal(h.live.defaultEffort, 'future-effort')
  await h.service.update({ defaultModel: null, lastWorkspace: null })
  assert.equal(h.live.defaultModel, null)
  assert.equal(h.live.lastWorkspace, null)
})

test('patch/maps, context choices, model IDs and instruction length are validated', async () => {
  for (const patch of [null, undefined, true, 2, 'text', [], new Date()]) {
    const h = harness()
    await assert.rejects(h.service.update(patch), /オブジェクト/)
    assert.deepEqual(h.events, [])
  }
  for (const field of ['contextLimits', 'subagentModels', 'fastMode']) {
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
  for (const value of [42, '', 'spaces not allowed', 'x'.repeat(101), {}, false]) {
    assert.throws(() => planSettingsUpdate(defaults(), { subagentModels: { anthropic: value } }, 0), /モデル ID/)
  }
  assert.equal(planSettingsUpdate(defaults(), { subagentModels: { anthropic: null } }, 0).settings.subagentModels.anthropic, null)
  assert.equal(planSettingsUpdate(defaults(), { customInstructions: 'x'.repeat(10_000) }, 0).settings.customInstructions.length, 10_000)
  assert.throws(() => planSettingsUpdate(defaults(), { customInstructions: 'x'.repeat(10_001) }, 0), /文字まで/)
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
  await h.service.update({ browserTool: true, modelAutoUpdate: true, dshUpdateChannel: 'latest', customInstructions: '' })
  assert.deepEqual(h.events, ['save', 'publish', 'home'])
  await h.service.update({ theme: 'light', notifications: false, checkpoints: false })
  assert.deepEqual(h.events.slice(3), ['save', 'publish'])
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

test('effect failure retains the saved commit and does not poison later updates', async () => {
  const h = harness({}, { home: () => { throw new Error('home patch unavailable') } })
  await assert.rejects(h.service.update({ customInstructions: 'already saved' }), /home patch unavailable/)
  assert.equal(h.live.customInstructions, 'already saved')
  assert.deepEqual(h.events, ['save', 'publish', 'home'])
  await h.service.update({ theme: 'light' })
  assert.equal(h.live.customInstructions, 'already saved')
  assert.equal(h.live.theme, 'light')
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

for (const [key, body] of [['teamPolicies', { text: 'original' }], ['teamPlaybooks', { description: 'when', body: 'original' }]]) {
  test(`${key}: queued stale saves cannot overwrite another window's changes`, async () => {
    const base = [{ id: 'a', name: 'A', ...body }, { id: 'b', name: 'B', ...body }]
    const field = key === 'teamPolicies' ? 'text' : 'body'
    const started = deferred()
    const finish = deferred()
    let first = true
    const h = harness({ [key]: base }, { save: async () => {
      if (!first) return
      first = false
      started.resolve()
      await finish.promise
    } })
    const one = structuredClone(base)
    one[0][field] = 'saved in window one'
    const two = structuredClone(base)
    two[1][field] = 'draft in window two'
    const saving = h.service.update({ [key]: one, teamGuidesBase: { [key]: base } })
    await started.promise
    const stale = h.service.update({ theme: 'light', [key]: two, teamGuidesBase: { [key]: base } })
    const rejected = assert.rejects(stale, /別の画面で更新/)
    finish.resolve()
    await saving
    await rejected
    assert.deepEqual(h.live[key], one)
    assert.equal(h.live.theme, 'dark', 'a conflict rejects the entire patch')
    assert.equal(h.writes.length, 1)
    assert.equal(h.published.length, 1)
    assert.equal(h.live.teamGuidesBase, undefined, 'save preconditions are not persisted')

    // Reloading the latest snapshot makes the next edit safe; the queue recovers.
    const latest = structuredClone(h.live[key])
    const retried = structuredClone(latest)
    retried[1][field] = 'rebased edit'
    await h.service.update({ [key]: retried, teamGuidesBase: { [key]: latest } })
    assert.equal(h.live[key][0][field], 'saved in window one')
    assert.equal(h.live[key][1][field], 'rebased edit')
  })

  test(`${key}: additions, deletions and missing bases cannot bypass conflict detection`, async () => {
    const base = [{ id: 'a', name: 'A', ...body }]
    for (const current of [[], [...base, { id: 'b', name: 'B', ...body }]]) {
      const h = harness({ [key]: current })
      await assert.rejects(h.service.update({ [key]: base, teamGuidesBase: { [key]: base } }), /別の画面で更新/)
      await assert.rejects(h.service.update({ [key]: base }), /編集元を確認/)
      assert.deepEqual(h.live[key], current)
      assert.deepEqual(h.events, [])
    }
    const h = harness({ [key]: base })
    await h.service.update({ [key]: [], teamGuidesBase: { [key]: base } })
    assert.deepEqual(h.live[key], [], 'deleting entries with the current base is allowed')
  })
}

test('policy and playbook save preconditions are independent', async () => {
  const h = harness()
  await h.service.update({ teamPolicies: [{ id: 'a', name: 'A', text: 'policy' }], teamGuidesBase: { teamPolicies: [] } })
  await h.service.update({ teamPlaybooks: [{ id: 'b', name: 'B', description: '', body: 'steps' }], teamGuidesBase: { teamPlaybooks: [] } })
  assert.equal(h.live.teamPolicies[0].text, 'policy')
  assert.equal(h.live.teamPlaybooks[0].body, 'steps')
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
    { maxChildren: 0 }, { maxChildren: 13 }, { maxChildren: 2.5 },
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
