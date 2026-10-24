import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAppServer, bundledCodex, CODEX_SIGNIN_HINT, DISABLED_CODEX_FEATURES, codexEnvironment } from '../server/codex-app-server.js'
import { normalizeCodexRateLimits, fetchChatGptUsage } from '../server/chatgpt-usage.js'
import { generateImage } from '../server/imagegen.js'
import { createRequire } from 'node:module'

const packageVersion = createRequire(import.meta.url)('../package.json').version
const fake = fileURLToPath(new URL('./helpers/fake-codex-app-server.mjs', import.meta.url))
async function setup(t, extra = {}) {
  // The client removes real paths; a short-name temp dir (C:\Users\RUNNER~1) would never match the mocks below.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-app-server-')))
  const client = new CodexAppServer({
    home: path.join(dir, 'codex-home'),
    command: process.execPath,
    args: [fake],
    ...extra
  })
  t.after(async () => {
    await client.stop()
    await fs.rm(dir, {
      recursive: true,
      force: true
    })
  })
  return {
    dir,
    client
  }
}
async function login(client, method) {
  const done = new Promise(resolve => {
    const listener = state => {
      if (state.phase === 'done') {
        client.off('login', listener)
        resolve()
      }
    }
    client.on('login', listener)
  })
  await client.loginStart(method)
  await done
  return client.account()
}
test('stop during Codex prepare prevents the pending start from spawning', async t => {
  let spawns = 0
  const { client } = await setup(t, {
    spawn: () => {
      spawns++
      throw new Error('unexpected spawn')
    }
  })
  const originalMkdir = fs.mkdir
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const preparing = new Promise(resolve => { entered = resolve })
  fs.mkdir = async (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(client.cwd)) {
      entered()
      await gate
    }
    return originalMkdir.call(fs, target, ...args)
  }
  try {
    const starting = client.start()
    await preparing
    await client.stop()
    release()
    await assert.rejects(starting, /stopped during startup/)
    assert.equal(spawns, 0)
  } finally {
    release()
    fs.mkdir = originalMkdir
  }
})
test('raw requests do not leave pending entries when transport is missing or write throws', async t => {
  const { client } = await setup(t)
  await assert.rejects(client.rawRequest('account/read'), /transport closed/)
  assert.equal(client.pending.size, 0)
  client.child = { stdin: { write() { throw new Error('sync write failure') } } }
  try {
    await assert.rejects(client.rawRequest('account/read'), /transport write failed/)
    assert.equal(client.pending.size, 0)
  } finally {
    client.child = null
  }
})
test('bundled binary is pinned/local and environment cannot inherit another Codex/API identity', () => {
  assert.match(bundledCodex(), /node_modules.*codex.*vendor/)
  assert.deepEqual(codexEnvironment('/dedicated', {
    HOME: '/user',
    CODEX_HOME: '/user/.codex',
    OPENAI_API_KEY: 'other',
    OPENAI_BASE_URL: 'other',
    CODEX_CONFIG: 'other'
  }), {
    HOME: '/user',
    CODEX_HOME: '/dedicated',
    CODEX_MANAGED_BY_NPM: '1'
  })
})
test('app-server initializes under own identity with lean config, login/logout are distinct from SIWC', async t => {
  const {
    client
  } = await setup(t)
  assert.equal((await client.account()).signedIn, false)
  const opened = []
  client.openUrl = url => opened.push(url)
  assert.equal((await login(client)).signedIn, true)
  assert.deepEqual(opened, ['https://auth.openai.com/mock'])
  const config = await fs.readFile(path.join(client.home, 'config.toml'), 'utf8')
  for (const feature of DISABLED_CODEX_FEATURES) assert.ok(config.includes(`${feature} = false`))
  assert.match(config, /code_mode_host = true/)
  assert.match(config, /image_generation = true/)
  const methods = (await fs.readFile(path.join(client.home, 'mock-methods.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(methods[0].params.clientInfo, {
    name: 'agent_desk',
    title: 'Agent Desk',
    version: packageVersion
  })
  assert.deepEqual(await client.logout(), {
    signedIn: false,
    email: null,
    plan: null
  })
})
test('device login fallback exposes only user code and verification page', async t => {
  const {
    client
  } = await setup(t)
  const states = []
  client.on('login', state => states.push(state))
  await login(client, 'device')
  assert.ok(states.some(state => state.phase === 'device' && state.userCode === 'TEST-CODE'))
  assert.ok(!JSON.stringify(states).includes('accessToken'))
})
test('unsigned-in image gives actionable message and never starts a model turn', async t => {
  const {
    client
  } = await setup(t)
  await assert.rejects(client.generate({
    prompt: 'circle'
  }), error => error.message === CODEX_SIGNIN_HINT)
  const methods = await fs.readFile(path.join(client.home, 'mock-methods.jsonl'), 'utf8')
  assert.doesNotMatch(methods, /turn\/start|thread\/start/)
  assert.deepEqual(await fetchChatGptUsage(client), {
    status: 'signed-out',
    message: CODEX_SIGNIN_HINT
  })
})
test('image turn saves exclusive workspace/preview files, retains png and records mock usage', async t => {
  const {
    dir,
    client
  } = await setup(t)
  await login(client)
  const workspace = path.join(dir, 'workspace'),
    previews = path.join(dir, 'previews')
  const result = await generateImage({
    prompt: 'a small blue circle',
    filename: 'circle',
    format: 'webp',
    size: '1024x1024',
    quality: 'low'
  }, {
    client,
    workspace,
    previews
  })
  assert.match(result[0].text, /generated-images\/circle.png/)
  assert.match(result[0].text, /Requested webp; Codex returned png/)
  assert.match(result[0].text, /24000 input/)
  assert.match(result[0].text, /\[agent-desk-preview\]/)
  const bytes = await fs.readFile(path.join(workspace, 'generated-images', 'circle.png'))
  assert.equal(bytes[0], 137)
  await generateImage({
    prompt: 'circle',
    filename: 'circle'
  }, {
    client,
    workspace
  })
  assert.ok((await fs.readdir(path.join(workspace, 'generated-images'))).includes('circle-2.png'))
  assert.deepEqual(await fs.readdir(path.join(client.home, 'generated_images')), [])
  const methods = (await fs.readFile(path.join(client.home, 'mock-methods.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const starts = methods.filter(entry => entry.method === 'thread/start')
  assert.equal(starts.length, 2)
  assert.ok(starts.every(entry => entry.params.ephemeral === true))
  await assert.rejects(client.cleanupImageThread('../auth'), /Invalid/)
})
test('image results accept 0.164 attachment references and legacy inline data', async t => {
  const { client } = await setup(t)
  const threadId = 'attachment-test'
  const root = path.join(client.home, 'generated_images', threadId)
  await fs.mkdir(root, { recursive: true })
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64')
  const savedPath = path.join(root, 'image.png')
  await fs.writeFile(savedPath, bytes)
  const item = {
    type: 'imageGeneration',
    id: 'image-attachment',
    status: 'completed',
    fileId: 'file-generated-image',
    savedPath,
    inputImages: [{ path: '/reference.png', sha256: 'a'.repeat(64) }],
    revisedPrompt: 'A small blue circle.'
  }
  const saved = await client.imageResult(threadId, [item])
  assert.deepEqual(saved.bytes, bytes)
  assert.equal(saved.source, 'item.savedPath')
  assert.equal(saved.format, 'png')
  assert.equal(saved.revisedPrompt, item.revisedPrompt)
  const inline = await client.imageResult(threadId, [{
    type: 'imageGeneration', status: 'completed', result: bytes.toString('base64')
  }])
  assert.deepEqual(inline.bytes, bytes)
  assert.equal(inline.source, 'item.result')
  const outside = path.join(client.home, 'outside.png')
  await fs.writeFile(outside, bytes)
  await assert.rejects(client.imageResult(threadId, [{ ...item, savedPath: outside }]), /outside this thread/)
})
test('image cleanup failure does not replace a generated image result', async t => {
  const { dir, client } = await setup(t)
  await login(client)
  const workspace = path.join(dir, 'workspace')
  const generated = path.join(client.home, 'generated_images', 'thread-mock')
  const originalRm = fs.rm
  fs.rm = async (target, ...args) => {
    if (path.resolve(String(target)) === generated) throw Object.assign(new Error('locked image thread'), { code: 'EBUSY' })
    return originalRm.call(fs, target, ...args)
  }
  try {
    const result = await generateImage({ prompt: 'circle', filename: 'retained' }, { client, workspace })
    assert.match(result[0].text, /Saved the image to generated-images\/retained.png/)
    assert.equal((await fs.readFile(path.join(workspace, 'generated-images', 'retained.png')))[0], 137)
    await assert.doesNotReject(fs.access(generated))
  } finally {
    fs.rm = originalRm
  }
})
test('image OFF is enforced before any client/model/network call', async () => {
  let calls = 0
  await assert.rejects(generateImage({
    prompt: 'circle'
  }, {
    client: {
      generate: () => {
        calls++
      }
    },
    enabled: async () => false
  }), /無効/)
  assert.equal(calls, 0)
})
test('rateLimits read and notifications map five-hour and weekly windows, not SIWC grants', async t => {
  const {
    client
  } = await setup(t)
  await login(client)
  const updated = once(client, 'rateLimits')
  const usage = await fetchChatGptUsage(client)
  await updated
  assert.equal(usage.status, 'ok')
  assert.deepEqual(usage.windows.map(window => [window.seconds, window.usedPercent]), [[18000, 25], [604800, 50]])
  assert.equal(normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        primary: {
          usedPercent: 120,
          windowDurationMins: 300,
          resetsAt: 1
        },
        rateLimitReachedType: 'limit'
      }
    }
  }).windows[0].usedPercent, 100)
})
test('runtime housekeeping removes only process diagnostics, keeps account files, and tolerates repeated stop', async t => {
  const {
    client
  } = await setup(t)
  await login(client)
  await fs.writeFile(path.join(client.runtimeHome, 'logs_2.sqlite'), 'transient log')
  await fs.writeFile(path.join(client.home, 'account-state.sqlite'), 'keep account state')
  await fs.mkdir(path.join(client.home, '.sandbox'), {
    recursive: true
  })
  await fs.writeFile(path.join(client.home, '.sandbox', 'sandbox.2026-10-21.log'), 'transient diagnostic')
  await client.stop()
  await client.stop()
  await assert.rejects(fs.access(client.runtimeHome), {
    code: 'ENOENT'
  })
  assert.equal(await fs.readFile(path.join(client.home, 'account-state.sqlite'), 'utf8'), 'keep account state')
  assert.equal(await fs.readFile(path.join(client.home, 'mock-auth'), 'utf8'), 'mock')
  assert.deepEqual(await fs.readdir(path.join(client.home, '.sandbox')), [])
})
test('runtime cleanup defers locked state and explicit stop still reports other failures', async t => {
  const { client } = await setup(t)
  await client.start()
  const runtimeHome = client.runtimeHome
  const originalRm = fs.rm
  fs.rm = async (target, ...args) => {
    if (path.resolve(String(target)) === runtimeHome) throw Object.assign(new Error('locked runtime'), { code: 'EBUSY' })
    return originalRm.call(fs, target, ...args)
  }
  try {
    await client.stop()
    await assert.doesNotReject(fs.access(runtimeHome))
  } finally {
    fs.rm = originalRm
  }
  await client.stop()
  await assert.rejects(fs.access(runtimeHome), { code: 'ENOENT' })

  await client.start()
  const retryRm = fs.rm
  fs.rm = async (target, ...args) => {
    if (path.resolve(String(target)) === runtimeHome) throw Object.assign(new Error('unexpected removal failure'), { code: 'EIO' })
    return retryRm.call(fs, target, ...args)
  }
  try {
    await assert.rejects(client.stop(), { code: 'EIO' })
  } finally {
    fs.rm = retryRm
  }
  await client.stop()
})
test('idle stop catches runtime cleanup rejection', async t => {
  const { client } = await setup(t, { idleMs: 100 })
  const runtimeHome = client.runtimeHome
  const originalRm = fs.rm
  const cleanupAttempted = new Promise(resolve => {
    fs.rm = async (target, ...args) => {
      if (path.resolve(String(target)) === runtimeHome) {
        resolve()
        throw Object.assign(new Error('unexpected removal failure'), { code: 'EIO' })
      }
      return originalRm.call(fs, target, ...args)
    }
  })
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  const stopped = once(client, 'stopped')
  process.on('unhandledRejection', onUnhandled)
  try {
    await login(client)
    await stopped
    await cleanupAttempted
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(client.child, null)
    assert.deepEqual(unhandled, [])
  } finally {
    fs.rm = originalRm
    process.off('unhandledRejection', onUnhandled)
  }
})
test('idle app-server shuts down and restarts using only its own saved auth', async t => {
  const {
    client
  } = await setup(t, {
    idleMs: 50
  })
  await login(client)
  const stopped = once(client, 'stopped')
  await stopped
  assert.equal(client.child, null)
  assert.equal((await client.account()).signedIn, true)
})
