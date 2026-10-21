import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { tryAcquireDataLock } from '../server/data-lock.js'

async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-data-lock-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  return home
}

test('only one simultaneous claimant owns a data folder; release is idempotent', async (t) => {
  const home = await temporary(t)
  const results = await Promise.all(Array.from({ length: 12 }, () => tryAcquireDataLock(home)))
  const winners = results.filter(Boolean)
  assert.equal(winners.length, 1)
  const release = winners[0]
  t.after(release)
  assert.equal(await tryAcquireDataLock(home), null)
  await Promise.all([release(), release()])
  const next = await tryAcquireDataLock(home)
  assert.equal(typeof next, 'function')
  await next()
})

test('different data folders have independent locks', async (t) => {
  const first = await temporary(t)
  const second = await temporary(t)
  const releaseFirst = await tryAcquireDataLock(first)
  const releaseSecond = await tryAcquireDataLock(second)
  assert.equal(typeof releaseFirst, 'function')
  assert.equal(typeof releaseSecond, 'function')
  await Promise.all([releaseFirst(), releaseSecond()])
})

test('directory aliases address the same lock', async (t) => {
  const home = await temporary(t)
  const release = await tryAcquireDataLock(home)
  t.after(release)
  assert.equal(await tryAcquireDataLock(path.join(home, '..', path.basename(home))), null)
  if (process.platform === 'win32') assert.equal(await tryAcquireDataLock(home.toUpperCase()), null)
})

test('process death releases the kernel lock without stale-owner cleanup', {
  skip: !['win32', 'linux'].includes(process.platform), timeout: 15000,
}, async (t) => {
  const home = await temporary(t)
  const moduleUrl = new URL('../server/data-lock.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { tryAcquireDataLock } from ${JSON.stringify(moduleUrl)};
    const release = await tryAcquireDataLock(${JSON.stringify(home)});
    if (!release) process.exit(2);
    console.log('locked');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill())
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error('lock holder exited early: ' + code) }),
  ])
  assert.equal(await tryAcquireDataLock(home), null)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const release = await tryAcquireDataLock(home)
  assert.equal(typeof release, 'function')
  await release()
})
