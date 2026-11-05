import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { mountMcpServers } from '../server/mcp-startup.js'
import { patchMcpStartupSource } from '../server/mcp-startup-patch.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(names, synchronousFailure = null, disposeFailure = false) {
  const started = [], disposed = []
  const gates = Object.fromEntries(names.map(name => [name, deferred()]))
  const error = new Error('fixture startup failure')
  const ctx = { plugin(_Client, config) {
    const name = config.serverName
    if (name === synchronousFailure) throw error
    started.push(name)
    return {
      then: (yes, no) => gates[name].promise.then(yes, no),
      async dispose() {
        disposed.push(name)
        gates[name].reject(new Error('fixture disposed'))
        if (disposeFailure) throw new Error('fixture cleanup error')
      },
    }
  } }
  return { ctx, gates, started, disposed, error, configs: names.map(serverName => ({ serverName })) }
}

test('built-in connections overlap but publication waits for every tool list', async () => {
  const f = fixture(['chrome', 'desktop', 'history', 'imagegen'])
  let complete = false
  const task = mountMcpServers(f.ctx, f.configs, {}).then(() => { complete = true })
  assert.deepEqual(f.started, ['chrome', 'desktop', 'history', 'imagegen'])
  f.gates.imagegen.resolve(); f.gates.desktop.resolve(); f.gates.history.resolve()
  await new Promise(setImmediate)
  assert.equal(complete, false)
  f.gates.chrome.resolve(); await task
  assert.equal(complete, true)
  assert.deepEqual(f.disposed, [])
})

test('unknown or team servers retain sequential startup and do not start after a failure', async () => {
  const f = fixture(['chrome', 'custom', 'desktop'])
  const task = mountMcpServers(f.ctx, f.configs, {})
  assert.deepEqual(f.started, ['chrome'])
  f.gates.chrome.resolve()
  await new Promise(setImmediate)
  assert.deepEqual(f.started, ['chrome', 'custom'])
  f.gates.custom.reject(f.error)
  await assert.rejects(task, error => error === f.error)
  assert.deepEqual(f.started, ['chrome', 'custom'])
})

test('an early failed startup disposes and settles every pending sibling before rejecting', async () => {
  const f = fixture(['chrome', 'desktop', 'history'])
  const task = mountMcpServers(f.ctx, f.configs, {})
  f.gates.chrome.reject(f.error)
  await assert.rejects(task, error => error === f.error)
  assert.deepEqual(f.disposed, ['chrome', 'desktop', 'history'])
  const outcomes = await Promise.allSettled(Object.values(f.gates).map(gate => gate.promise))
  assert.ok(outcomes.every(result => result.status === 'rejected'))
})

test('synchronous plugin throws and teardown failures preserve the original error and settle started fibers', async () => {
  const f = fixture(['chrome', 'desktop', 'history'], 'desktop', true)
  await assert.rejects(mountMcpServers(f.ctx, f.configs, {}), error => error === f.error)
  assert.deepEqual(f.started, ['chrome'])
  assert.deepEqual(f.disposed, ['chrome'])
  await assert.rejects(f.gates.chrome.promise, /fixture disposed/)
})

test('multiple failing connections are all observed without unhandled rejections', async () => {
  const f = fixture(['chrome', 'desktop', 'history'])
  const task = mountMcpServers(f.ctx, f.configs, {})
  const other = new Error('second failure')
  f.gates.desktop.reject(f.error); f.gates.chrome.reject(other)
  await assert.rejects(task, error => error === f.error || error === other)
  assert.equal(f.disposed.length, 3)
})

test('the source patch is unique, checks upstream anchors and refuses duplicate application', async () => {
  const require = createRequire(import.meta.url)
  const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-acp'), 'utf8')
  const patched = patchMcpStartupSource(source)
  assert.ok(patched)
  assert.match(patched, /await agentDeskMountMcp/)
  assert.equal(patchMcpStartupSource(patched), null)
  assert.equal(patchMcpStartupSource(source.replace('const configs = resolveMcpConfigs(servers, sessionCwd);', 'const configs = [];')), null)
  assert.equal(patchMcpStartupSource(source + source), null)
})
