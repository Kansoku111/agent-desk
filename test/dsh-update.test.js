import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { compareVersions, DshUpdater, pickUpdate } from '../server/dsh-update.js'

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

const RELEASES = { distTags: { latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' }, companionVersions: ['0.2.0-rc.2', '0.2.1-alpha.1'] }

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-update-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'app')
  const home = path.join(dir, 'data')
  const dshHome = path.join(home, 'dsh-home')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(dshHome, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), '{"dsh":"old"}')
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"lock":"old"}')
  await fs.writeFile(path.join(dshHome, 'sessions', 'a.json'), 'old-session')
  const calls = []
  let busy = false
  const updater = new DshUpdater({
    root,
    home,
    dshHome,
    installed: '0.2.0-rc.2',
    getSettings: () => ({ channel: 'alpha', auto: false }),
    isBusy: () => busy,
    lock: async () => { calls.push('lock') },
    unlock: () => calls.push('unlock'),
    restart: async () => {
      calls.push('restart')
      return true
    },
    lookup: async () => RELEASES,
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`)
      if (args.includes('--save-exact')) {
        await fs.writeFile(path.join(root, 'package.json'), '{"dsh":"new"}')
        await fs.writeFile(path.join(root, 'package-lock.json'), '{"lock":"new"}')
      }
      return { stdout: '', stderr: '' }
    },
    verify: async () => {
      calls.push('verify')
      return { ok: true }
    },
    ...overrides,
  })
  await updater.load()
  return { updater, calls, root, home, dshHome, setBusy: (value) => { busy = value } }
}

test('an update installs, verifies and restarts', async (t) => {
  const { updater, calls, home } = await fixture(t)
  assert.equal((await updater.check()).available, '0.2.1-alpha.1')
  const state = await updater.apply('0.2.1-alpha.1')
  assert.equal(state.phase, 'restarting')
  assert.equal(state.installed, '0.2.1-alpha.1')
  assert.equal(state.lastResult.ok, true)
  assert.deepEqual(calls, [
    'lock',
    'npm install --save-exact --no-audit --no-fund @deepseek-ai/dsh@0.2.1-alpha.1 @deepseek-ai/dsh-atomic-write@0.2.1-alpha.1',
    'verify',
    'restart',
  ])
  // The backup holds the state from before the update.
  assert.equal(await fs.readFile(path.join(home, 'dsh-update-backup', 'package.json'), 'utf8'), '{"dsh":"old"}')
  const guide = await fs.readFile(path.join(home, 'dsh-update-backup', 'RECOVERY.md'), 'utf8')
  assert.match(guide, /npm ci --no-audit --no-fund/)
  assert.match(guide, /復旧を再試行/)
  assert.match(guide, /削除・編集して停止を解除しない/)
  const saved = JSON.parse(await fs.readFile(path.join(home, 'dsh-update.json'), 'utf8'))
  assert.equal(saved.lastResult.to, '0.2.1-alpha.1')
})

test('a failed check rolls back packages and the dsh home', async (t) => {
  const { updater, calls, root, dshHome } = await fixture(t, {
    verify: async () => {
      await fs.writeFile(path.join(dshHome, 'sessions', 'a.json'), 'migrated')
      await fs.writeFile(path.join(dshHome, 'new-format.db'), 'x')
      throw new Error('dsh exited during startup (code 1)\nstack…')
    },
  })
  await updater.check()
  const state = await updater.apply('0.2.1-alpha.1')
  assert.equal(state.phase, 'available')
  assert.equal(state.installed, '0.2.0-rc.2')
  assert.equal(state.failed['0.2.1-alpha.1'], 'dsh exited during startup (code 1)')
  assert.match(state.error, /動作確認に失敗したため、0\.2\.0-rc\.2 のまま使います/)
  assert.equal(state.lastResult.ok, false)
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{"dsh":"old"}')
  assert.equal(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'), '{"lock":"old"}')
  assert.equal(await fs.readFile(path.join(dshHome, 'sessions', 'a.json'), 'utf8'), 'old-session')
  await assert.rejects(fs.stat(path.join(dshHome, 'new-format.db')))
  assert.ok(calls.includes('npm ci --no-audit --no-fund'))
  assert.equal(calls.at(-1), 'unlock')
  assert.ok(!calls.includes('restart'))
})

test('a failed install restores the packages but leaves the dsh home alone', async (t) => {
  const { updater, calls, root, dshHome } = await fixture(t, {
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`)
      if (args.includes('--save-exact')) {
        await fs.writeFile(path.join(root, 'package.json'), '{"dsh":"half"}')
        throw new Error('npm install が失敗しました（コード 1）\nETARGET')
      }
      return { stdout: '', stderr: '' }
    },
  })
  await fs.writeFile(path.join(dshHome, 'written-meanwhile'), 'keep')
  await updater.check()
  const state = await updater.apply('0.2.1-alpha.1')
  assert.match(state.error, /インストールに失敗/)
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{"dsh":"old"}')
  assert.equal(await fs.readFile(path.join(dshHome, 'written-meanwhile'), 'utf8'), 'keep')
  assert.ok(!calls.includes('verify'))
})

test('an update waits for running tasks', async (t) => {
  const { updater, calls, setBusy } = await fixture(t)
  await updater.check()
  setBusy(true)
  assert.equal((await updater.apply('0.2.1-alpha.1')).phase, 'waiting')
  assert.deepEqual(calls, [])
  updater.onIdle()
  assert.deepEqual(calls, [])
  setBusy(false)
  const done = new Promise((resolve) => updater.on('state', (state) => state.phase === 'restarting' && resolve()))
  updater.onIdle()
  // Locked synchronously, before the install starts.
  assert.equal(updater.locked, true)
  await done
  // The restart follows once the result is saved.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(calls.includes('restart'))
})

test('a waiting update can be cancelled, and only the offered version installs', async (t) => {
  const { updater, setBusy } = await fixture(t)
  await updater.check()
  await assert.rejects(updater.apply('9.9.9'), /インストールできるバージョンではありません/)
  setBusy(true)
  await updater.apply('0.2.1-alpha.1')
  assert.equal(updater.cancel().phase, 'available')
})

test('auto update skips a release that already failed', async (t) => {
  const { updater, calls, home } = await fixture(t, { getSettings: () => ({ channel: 'alpha', auto: true }) })
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify({ failed: { '0.2.1-alpha.1': 'broken' } }))
  await updater.load()
  const state = await updater.check()
  assert.equal(state.phase, 'available')
  assert.deepEqual(calls, [])
})

test('auto update installs a new release', async (t) => {
  const { updater, calls } = await fixture(t, { getSettings: () => ({ channel: 'alpha', auto: true }) })
  const state = await updater.check()
  assert.equal(state.phase, 'restarting')
  assert.ok(calls.includes('verify'))
})

test('auto update honors a setting change while release lookup is pending', async (t) => {
  let settings = { channel: 'alpha', auto: true }
  let startLookup
  let finishLookup
  const lookupStarted = new Promise((resolve) => { startLookup = resolve })
  const lookupResult = new Promise((resolve) => { finishLookup = resolve })
  const { updater, calls } = await fixture(t, {
    getSettings: () => settings,
    lookup: async () => {
      startLookup()
      return lookupResult
    },
  })

  const checking = updater.check()
  await lookupStarted
  settings = { channel: 'alpha', auto: false }
  finishLookup(RELEASES)
  const state = await checking

  assert.equal(state.phase, 'available')
  assert.equal(state.available, '0.2.1-alpha.1')
  assert.deepEqual(calls, [])
})

test('auto update uses the latest channel after release lookup', async (t) => {
  let settings = { channel: 'latest', auto: true }
  let startLookup
  let finishLookup
  const lookupStarted = new Promise((resolve) => { startLookup = resolve })
  const lookupResult = new Promise((resolve) => { finishLookup = resolve })
  const { updater, calls } = await fixture(t, {
    getSettings: () => settings,
    lookup: async () => {
      startLookup()
      return lookupResult
    },
  })

  const checking = updater.check()
  await lookupStarted
  settings = { channel: 'alpha', auto: true }
  finishLookup(RELEASES)
  const state = await checking

  assert.equal(state.phase, 'restarting')
  assert.ok(calls.includes('verify'))
})

test('without a restart the runtimes come back right away', async (t) => {
  const { updater, calls } = await fixture(t, { restart: async () => false })
  await updater.check()
  const state = await updater.apply('0.2.1-alpha.1')
  assert.equal(state.phase, 'idle')
  assert.equal(state.installed, '0.2.1-alpha.1')
  assert.equal(calls.at(-1), 'unlock')
})

test('a failed registry lookup is reported, not thrown', async (t) => {
  const { updater } = await fixture(t, { lookup: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') } })
  const state = await updater.check()
  assert.equal(state.phase, 'idle')
  assert.match(state.error, /ENOTFOUND/)
})

async function reload(updater) {
  return new DshUpdater({ ...updater, installed: updater.state.installed }).load()
}

test('npm recovery failure still restores home and persists a barrier across restart', async (t) => {
  const { updater, calls, home, dshHome } = await fixture(t)
  const npm = updater.npm
  updater.npm = async (args, options) => {
    if (args[0] === 'ci') throw new Error('registry unavailable')
    return npm(args, options)
  }
  updater.verify = async () => {
    await fs.writeFile(path.join(dshHome, 'sessions', 'a.json'), 'migrated')
    await fs.writeFile(path.join(dshHome, 'sessions', 'new.json'), 'nested migration artifact')
    throw new Error('goal hook did not match')
  }
  let rolledBack = 0
  updater.on('rolled-back', () => rolledBack++)
  await updater.check()
  const state = await updater.apply('0.2.1-alpha.1')
  assert.equal(state.phase, 'recovery-required')
  assert.equal(state.recovery.packages, true)
  assert.equal(state.recovery.home, false)
  assert.equal(state.lastResult.recovered, false)
  assert.equal(updater.locked, true)
  assert.equal(updater.blocking, true)
  assert.equal(rolledBack, 0)
  assert.ok(!calls.includes('unlock'))
  assert.equal(await fs.readFile(path.join(dshHome, 'sessions', 'a.json'), 'utf8'), 'old-session')
  await assert.rejects(fs.stat(path.join(dshHome, 'sessions', 'new.json')))
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'dsh-update.json'), 'utf8')).phase, 'recovery-required')

  const restarted = await reload(updater)
  restarted.lookup = async () => { throw new Error('must not check while recovering') }
  assert.equal(restarted.blocking, true)
  assert.deepEqual(await restarted.check(), restarted.snapshot())
  assert.equal(restarted.cancel().phase, 'recovery-required')
  await assert.rejects(restarted.apply('0.2.1-alpha.1'), /復旧が必要/)
  assert.equal(restarted.blocking, true)
  // Fixing the npm problem and explicitly retrying is a complete recovery path.
  restarted.npm = npm
  restarted.on('rolled-back', () => rolledBack++)
  const recovered = await restarted.retryRecovery()
  assert.equal(recovered.phase, 'available')
  assert.equal(recovered.recovery, null)
  assert.equal(recovered.lastResult.recovered, true)
  assert.equal(restarted.blocking, false)
  assert.equal(rolledBack, 1)
  assert.equal(calls.at(-1), 'unlock')
  assert.equal((await reload(restarted)).blocking, false)
})

test('home recovery failure does not redo successful npm compensation on explicit retry', async (t) => {
  const { updater, calls } = await fixture(t, { verify: async () => { throw new Error('startup failed') } })
  const restore = updater.restoreHome
  updater.restoreHome = async () => { throw new Error('home is busy') }
  let rolledBack = 0
  updater.on('rolled-back', () => rolledBack++)
  await updater.check()
  await updater.apply('0.2.1-alpha.1')
  assert.equal(updater.state.phase, 'recovery-required')
  assert.equal(updater.state.recovery.packages, false)
  assert.equal(updater.state.recovery.home, true)
  assert.ok(!calls.includes('unlock'))
  assert.equal(rolledBack, 0)
  updater.restoreHome = restore
  await updater.retryRecovery()
  assert.equal(calls.filter((call) => call.startsWith('npm ci')).length, 1)
  assert.equal(rolledBack, 1)
  assert.equal(updater.blocking, false)
})

test('both compensations report their failures without dropping the backup', async (t) => {
  const { updater, home, calls } = await fixture(t, { verify: async () => { throw new Error('bad source') } })
  const npm = updater.npm
  updater.npm = (args, options) => args[0] === 'ci' ? Promise.reject(new Error('npm failed')) : npm(args, options)
  updater.restoreHome = async () => { throw new Error('home failed') }
  await updater.check()
  await updater.apply('0.2.1-alpha.1')
  assert.deepEqual(updater.state.recovery.errors, { packages: 'npm failed', home: 'home failed' })
  assert.equal(updater.state.phase, 'recovery-required')
  assert.ok(!calls.includes('unlock'))
  assert.equal(await fs.readFile(path.join(home, 'dsh-update-backup', 'dsh-home', 'sessions', 'a.json'), 'utf8'), 'old-session')
})

test('a interrupted verification is blocked on load and explicitly recoverable', async (t) => {
  const { updater, home, dshHome } = await fixture(t)
  await updater.check()
  await updater.apply('0.2.1-alpha.1') // Generates the fixture backup, using mocks only.
  await fs.writeFile(path.join(dshHome, 'sessions', 'a.json'), 'interrupted migration')
  await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify({
    phase: 'verifying', installed: '0.2.0-rc.2', target: '0.2.1-alpha.1',
    recovery: { from: '0.2.0-rc.2', version: '0.2.1-alpha.1', stage: 'verify', packages: true, home: true, errors: {} },
  }))
  const restarted = await reload(updater)
  assert.equal(restarted.state.phase, 'recovery-required')
  assert.equal((await restarted.check()).phase, 'recovery-required')
  await restarted.retryRecovery()
  assert.equal(restarted.blocking, false)
  assert.equal(restarted.state.installed, '0.2.0-rc.2')
  assert.equal(await fs.readFile(path.join(dshHome, 'sessions', 'a.json'), 'utf8'), 'old-session')
})

test('a corrupt journal fails closed instead of treating it as idle preferences', async (t) => {
  const { updater, home } = await fixture(t)
  await fs.writeFile(path.join(home, 'dsh-update.json'), '{broken')
  const restarted = await reload(updater)
  assert.equal(restarted.blocking, true)
  assert.equal((await restarted.check()).phase, 'recovery-required')
  assert.equal((await restarted.retryRecovery()).phase, 'recovery-required')
})

test('failure to persist completed recovery never unlocks or announces rollback', async (t) => {
  const { updater, calls } = await fixture(t, { verify: async () => { throw new Error('bad source') } })
  const save = updater.saveState
  updater.saveState = async (file, state) => {
    if (state.lastResult?.recovered === true) throw new Error('disk full')
    return save(file, state)
  }
  let rolledBack = false
  updater.on('rolled-back', () => { rolledBack = true })
  await updater.check()
  await updater.apply('0.2.1-alpha.1')
  assert.equal(updater.state.phase, 'recovery-required')
  assert.ok(!calls.includes('unlock'))
  assert.equal(rolledBack, false)
  assert.equal((await reload(updater)).blocking, true)
  updater.saveState = save
  await updater.retryRecovery()
  assert.equal(updater.blocking, false)
  assert.equal(rolledBack, true)
})

const validRecoveryRecord = () => ({
  from: '0.2.0-rc.2', version: '0.2.1-alpha.1', stage: 'verify', packages: false, home: false, errors: {},
})

for (const [label, recovery] of [
  ['empty object', {}],
  ['string', 'recovered'],
  ['falsy value', false],
  ['string package flag', { ...validRecoveryRecord(), packages: 'no' }],
  ['missing errors', { ...validRecoveryRecord(), errors: undefined }],
  ['string errors', { ...validRecoveryRecord(), errors: 'none' }],
  ['array errors', { ...validRecoveryRecord(), errors: [] }],
  ['non-string error value', { ...validRecoveryRecord(), errors: { home: 1 } }],
  ['invalid stage enum', { ...validRecoveryRecord(), stage: 'done' }],
  ['invalid original version', { ...validRecoveryRecord(), from: 'old' }],
  ['invalid target version', { ...validRecoveryRecord(), version: null }],
  ['missing home flag', { ...validRecoveryRecord(), home: undefined }],
]) {
  test(`malformed recovery (${label}) falls back to both compensations and backup metadata`, async (t) => {
    const { updater, root, home, dshHome, calls } = await fixture(t)
    await updater.check()
    await updater.apply('0.2.1-alpha.1') // Mock install creates a complete temporary backup.
    await fs.writeFile(path.join(dshHome, 'sessions', 'a.json'), 'unrestored migration')
    await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify({ phase: 'recovery-required', recovery }))
    const restarted = await reload(updater)
    assert.equal(restarted.state.phase, 'recovery-required')
    assert.equal(restarted.state.recovery.stage, 'unknown')
    assert.equal(restarted.state.recovery.from, null)
    assert.equal(restarted.state.recovery.packages, true)
    assert.equal(restarted.state.recovery.home, true)
    assert.equal((await restarted.check()).phase, 'recovery-required')
    assert.ok(!calls.includes('unlock'))
    let restoredHome = 0
    const restore = restarted.restoreHome
    restarted.restoreHome = async (...args) => { restoredHome++; await restore(...args) }
    const result = await restarted.retryRecovery()
    assert.equal(result.installed, '0.2.0-rc.2') // From backup.json, never malformed state.
    assert.equal(result.recovery, null)
    assert.equal(restarted.blocking, false)
    assert.equal(calls.filter((call) => call.startsWith('npm ci')).length, 1)
    assert.equal(restoredHome, 1)
    assert.equal(calls.at(-1), 'unlock')
    assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{"dsh":"old"}')
    assert.equal(await fs.readFile(path.join(dshHome, 'sessions', 'a.json'), 'utf8'), 'old-session')
  })
}

test('malformed journals remain blocked and retryable without valid backup metadata', async (t) => {
  const { updater, home, calls } = await fixture(t)
  for (const saved of [
    { recovery: {} },
    { phase: 'recovery-required' },
    { phase: 'recovery-required', recovery: null },
    { phase: 'not-a-phase', recovery: validRecoveryRecord() },
    { phase: 'recovery-required', installed: 'unknown', recovery: validRecoveryRecord() },
    { phase: 'recovery-required', target: 1, recovery: validRecoveryRecord() },
    { phase: 'recovery-required', lastResult: {}, recovery: validRecoveryRecord() },
  ]) {
    await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify(saved))
    const restarted = await reload(updater)
    assert.equal(restarted.state.recovery.stage, 'unknown')
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await restarted.retryRecovery()).phase, 'recovery-required')
      assert.equal(restarted.blocking, true)
    }
    assert.equal((await reload(restarted)).blocking, true)
  }
  assert.ok(!calls.includes('unlock'))
  assert.ok(!calls.some((call) => call.startsWith('npm ')))
})

test('legacy metadata without a phase remains compatible', async (t) => {
  const { updater, home } = await fixture(t)
  const saved = {
    checkedAt: 123, failed: { '0.2.1-alpha.1': 'previous failure' },
    lastResult: { ok: false, from: '0.2.0-rc.2', to: '0.2.1-alpha.1', at: 100, error: 'previous failure' },
  }
  await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify(saved))
  const restarted = await reload(updater)
  assert.equal(restarted.state.phase, 'idle')
  assert.equal(restarted.blocking, false)
  assert.equal(restarted.state.checkedAt, saved.checkedAt)
  assert.deepEqual(restarted.state.failed, saved.failed)
  assert.deepEqual(restarted.state.lastResult, saved.lastResult)
})

test('unexpected recovery completion errors return to a durable retryable phase', async (t) => {
  const { updater, home, calls } = await fixture(t)
  await updater.check()
  await updater.apply('0.2.1-alpha.1')
  await fs.writeFile(path.join(home, 'dsh-update.json'), JSON.stringify({ phase: 'recovery-required', recovery: {} }))
  const restarted = await reload(updater)
  const unlock = restarted.unlock
  restarted.unlock = () => { throw new Error('pool resume failed') }
  let rolledBack = 0
  restarted.on('rolled-back', () => rolledBack++)
  const failed = await restarted.retryRecovery()
  assert.equal(failed.phase, 'recovery-required')
  assert.match(failed.recovery.errors.retry, /pool resume failed/)
  assert.equal((await reload(restarted)).blocking, true)
  assert.equal(rolledBack, 0)
  restarted.unlock = unlock
  await restarted.retryRecovery()
  assert.equal(restarted.blocking, false)
  assert.equal(rolledBack, 1)
  assert.equal(calls.filter((call) => call.startsWith('npm ci')).length, 1)
})

test('the durable barrier precedes the first npm mutation', async (t) => {
  const { updater, home } = await fixture(t)
  const npm = updater.npm
  updater.npm = async (args, options) => {
    const saved = JSON.parse(await fs.readFile(path.join(home, 'dsh-update.json'), 'utf8'))
    assert.equal(saved.phase, 'installing')
    assert.equal(saved.recovery.packages, true)
    assert.equal((await reload(updater)).blocking, true)
    return npm(args, options)
  }
  await updater.check()
  await updater.apply('0.2.1-alpha.1')
  assert.equal(updater.state.phase, 'restarting')
})
