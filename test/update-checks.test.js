import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeVersion, compareVersions, newer, pickUpdate, UpdateChecker, updatePrompt } from '../server/update-checks.js'

test('compareVersions orders releases and prereleases', () => {
  const ordered = ['0.1.7-rc.2', '0.2.0-alpha.1', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.2.1-alpha.1', '0.10.0']
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`)
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1)
  }
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.2'), 0)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.throws(() => compareVersions('latest', '1.0.0'))
})

test('newer only offers a later valid version', () => {
  assert.equal(newer('1.0.0', '1.0.1'), '1.0.1')
  assert.equal(newer('1.0.1', '1.0.0'), null)
  assert.equal(newer('1.0.0', 'garbage'), null)
  assert.equal(newer(null, '1.0.0'), null)
})

test('pickUpdate follows the channel and never goes back', () => {
  const distTags = { latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' }
  const companionVersions = ['0.2.0-rc.2', '0.2.1-alpha.1']
  assert.equal(pickUpdate({ installed: '0.2.0-rc.2', channel: 'latest', distTags, companionVersions }), null)
  assert.equal(pickUpdate({ installed: '0.2.0-rc.2', channel: 'alpha', distTags, companionVersions }), '0.2.1-alpha.1')
  assert.equal(pickUpdate({ installed: '0.1.7-rc.2', channel: 'latest', distTags, companionVersions }), '0.2.0-rc.2')
  // An alpha that fell behind latest still yields latest.
  assert.equal(pickUpdate({ installed: '0.1.7-rc.2', channel: 'alpha', distTags: { latest: '0.3.0', alpha: '0.2.1-alpha.1' }, companionVersions: ['0.3.0', '0.2.1-alpha.1'] }), '0.3.0')
  // Installed newer than the channel: stay.
  assert.equal(pickUpdate({ installed: '0.2.1-alpha.1', channel: 'latest', distTags, companionVersions }), null)
  // dsh-atomic-write not published for that release yet.
  assert.equal(pickUpdate({ installed: '0.2.0-rc.2', channel: 'alpha', distTags, companionVersions: ['0.2.0-rc.2'] }), null)
  assert.equal(pickUpdate({ installed: '0.2.0-rc.2', channel: 'latest', distTags: { latest: 'garbage' }, companionVersions }), null)
})

test('the prompt states facts and leaves the steps to the repository', () => {
  const prompt = updatePrompt('dsh', { root: 'F:\\repo', installed: '0.2.0', available: '0.2.1', channel: 'next' })
  assert.match(prompt, /0\.2\.0 から 0\.2\.1/)
  assert.match(prompt, /next チャンネル/)
  assert.match(prompt, /F:\\repo/)
  assert.match(prompt, /docs\/updating\.md/)
  assert.match(prompt, /npmjs\.com\/package\/@deepseek-ai\/dsh\/v\/0\.2\.1/)
  assert.match(updatePrompt('codex', { root: '/r', installed: '0.163.0', available: '0.170.0', channel: null }), /releases\/tag\/rust-v0\.170\.0/)
})

test('claudeVersion reads the version line and reports a missing CLI as null', async () => {
  assert.equal(await claudeVersion({ run: async () => '2.1.3 (Claude Code)\n' }), '2.1.3')
  assert.equal(await claudeVersion({ run: async () => null }), null)
  await assert.rejects(claudeVersion({ run: async () => 'unexpected' }))
})

const RELEASES = {
  dsh: { distTags: { latest: '0.2.0', alpha: '0.2.1-alpha.1' }, companionVersions: ['0.2.0', '0.2.1-alpha.1'] },
  codex: { latest: '0.170.0' },
  claude: { latest: '2.2.0' },
}

function checker(overrides = {}) {
  let channel = 'latest'
  const instance = new UpdateChecker({
    root: '/repo',
    installed: { dsh: '0.2.0', codex: '0.163.0' },
    getChannel: () => channel,
    lookup: async () => structuredClone(RELEASES),
    readClaude: async () => '2.1.0',
    source: true,
    ...overrides,
  })
  return { instance, setChannel: (value) => { channel = value } }
}

test('a check reports each component and prompts only with a source checkout', async () => {
  const { instance } = checker()
  const state = await instance.check()
  assert.equal(state.checking, false)
  assert.ok(state.checkedAt)
  assert.equal(state.dsh.available, null)
  assert.equal(state.dsh.prompt, null)
  assert.equal(state.codex.available, '0.170.0')
  assert.match(state.codex.prompt, /0\.163\.0 から 0\.170\.0/)
  assert.deepEqual(state.claude, { installed: '2.1.0', available: '2.2.0', error: null, updating: false })

  const installed = checker({ source: false }).instance
  assert.equal((await installed.check()).codex.prompt, null)
})

test('a channel change recomputes dsh without asking the registry again', async () => {
  let lookups = 0
  const { instance, setChannel } = checker({ lookup: async () => { lookups += 1; return structuredClone(RELEASES) } })
  await instance.check()
  setChannel('alpha')
  instance.channelChanged()
  assert.equal(lookups, 1)
  assert.equal(instance.snapshot().dsh.available, '0.2.1-alpha.1')
  assert.match(instance.snapshot().dsh.prompt, /alpha チャンネル/)
})

test('one failing lookup leaves the other components', async () => {
  const { instance } = checker({
    lookup: async () => ({ ...structuredClone(RELEASES), codex: { error: new Error('npm view が失敗しました\ndetails') } }),
    readClaude: async () => { throw new Error('boom') },
  })
  const state = await instance.check()
  assert.equal(state.codex.available, null)
  assert.equal(state.codex.error, '確認に失敗しました: npm view が失敗しました')
  assert.equal(state.dsh.error, null)
  assert.equal(state.claude.installed, null)
  assert.match(state.claude.error, /boom/)
})

test('concurrent checks share one lookup', async () => {
  let lookups = 0
  const { instance } = checker({ lookup: async () => { lookups += 1; return structuredClone(RELEASES) } })
  await Promise.all([instance.check(), instance.check()])
  assert.equal(lookups, 1)
})

test('updating Claude Code reads the version again and clears the offer', async () => {
  let version = '2.1.0'
  const { instance } = checker({
    readClaude: async () => version,
    updateClaude: async () => { version = '2.2.0'; return 'Successfully updated' },
  })
  await instance.check()
  const states = []
  instance.on('state', (state) => states.push(state.claude.updating))
  const state = await instance.updateClaude()
  assert.deepEqual(states, [true, false])
  assert.equal(state.claude.installed, '2.2.0')
  assert.equal(state.claude.available, null)
  assert.equal(state.claude.error, null)
})

test('a failed Claude Code update is reported', async () => {
  const { instance } = checker({ updateClaude: async () => { throw new Error('locked\nmore') } })
  await instance.check()
  const state = await instance.updateClaude()
  assert.equal(state.claude.error, '更新に失敗しました: locked')
  assert.equal(state.claude.available, '2.2.0')
  assert.equal(state.claude.updating, false)
})
