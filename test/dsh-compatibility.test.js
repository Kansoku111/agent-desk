import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { composeCompatibilityPatches, runtimeHookArgs } from '../server/dsh-compatibility.js'
import { patchAcpSource } from '../server/steer-patch.js'
import { patchGoalSource, patchGoalDriverSource } from '../server/goal-patch.js'
import { patchMcpTimeoutSource } from '../server/mcp-timeout-patch.js'
import { patchRetrySource } from '../server/retry-patch.js'
import { patchOutputSpeedSource } from '../server/output-speed-patch.js'
import { patchFsSearchSource } from '../server/fs-search-patch.js'
import { patchGoalToolSource } from '../server/goal-tool-patch.js'
import { patchPtcSource } from '../server/ptc-patch.js'

const project = fileURLToPath(new URL('../', import.meta.url))

/** Runs scripts/check-dsh.mjs in a fresh process, as docs/updating.md has it run after a dsh update. */
function verifyInstall({ root, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'check-dsh.mjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      let report = null
      try { report = JSON.parse(stdout.trim().split('\n').at(-1)) } catch {}
      if (code === 0 && report?.ok && report.compatibility?.ok === true) return resolve(report)
      reject(new Error(report?.error ?? `check-dsh exited with ${code}\n${stderr.trim().slice(-1500)}`))
    })
  })
}
const require = createRequire(import.meta.url)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-compat-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const put = async (name, content) => {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
    return file
  }
  const pkg = async (name, main = 'lib/index.js', extra = {}) => {
    const dir = `node_modules/${name}`
    await put(`${dir}/package.json`, JSON.stringify({ name, version: '1.0.0', type: 'module', main, ...extra }))
    await put(`${dir}/${main}`, 'export {}')
    return dir
  }
  await put('package.json', '{"type":"module"}')
  await fs.mkdir(path.join(root, 'scripts'))
  await fs.mkdir(path.join(root, 'server'))
  for (const file of ['scripts/check-dsh.mjs', ...[
    'dsh-compatibility.js', 'steer-patch.js', 'goal-patch.js', 'retry-patch.js', 'mcp-timeout-patch.js', 'fast-mode-hook.js', 'fast-mode.js',
    'steer-hook.js', 'retry-hook.js', 'goal-hook.js', 'mcp-timeout-hook.js', 'opencode-catalog-hook.js', 'opencode-go-catalog.js',
    'output-speed-hook.js', 'output-speed-patch.js', 'output-speed-bridge.js', 'output-speed.js',
    'fs-search-hook.js', 'fs-search-patch.js', 'fs-search.js',
    'goal-tool-hook.js', 'goal-tool-patch.js', 'goal-wait-hook.js', 'goal-wait.js',
    'ptc-hook.js', 'ptc-patch.js',
  ].map((file) => `server/${file}`)]) {
    await fs.copyFile(path.join(project, file), path.join(root, file))
  }
  // The real check script runs against only temporary mock runtimes/catalogs.
  // No dsh boot, npm command, provider call or user data is touched by this test.
  await put('server/siwc-request.js', 'export const withSiwc = (_model, options) => options')
  await put('server/paths.js', 'export const appPaths = () => ({settings: "unused", home: "unused", runtimeCwd: "unused"})')
  await put('server/json-file.js', 'export const readJson = async () => ({}); export const writeJson = async () => {}')
  await put('server/model-updates.js', 'export const readFetchedCatalog = async () => null')
  await put('server/model-catalog.js', `import fs from 'node:fs/promises'; export const ensureModelCatalog = async () => { await fs.writeFile(${JSON.stringify(path.join(root, 'catalog-touched'))}, 'yes'); return { warnings: [] } }`)
  await put('server/transcript.js', 'export const parseConfigOptions = (options) => options')
  await put('server/runtime.js', `
    import fs from 'node:fs/promises'
    const config = { models: [{value: 'fixture-model'}], currentModel: 'fixture-model' }
    export class AcpRuntime {
      async start() { await fs.writeFile(${JSON.stringify(path.join(root, 'runtime-started'))}, 'yes') }
      async newSession() { return { sessionId: 'fixture', configOptions: config } }
      async setOption() { return config }
      async closeSession() {}
      async stop() {}
    }
  `)
  await pkg('@deepseek-ai/dsh')
  await pkg('@deepseek-ai/dsh-acp-app')
  await pkg('@deepseek-ai/dsh-base')
  const acpDir = await pkg('@deepseek-ai/dsh-acp')
  const llmDir = await pkg('@deepseek-ai/dsh-llm-pi-ai')
  const searchDir = await pkg('@deepseek-ai/dsh-tool-fs-search')
  const goalToolDir = await pkg('@deepseek-ai/dsh-tool-goal')
  const goalDriverDir = await pkg('@deepseek-ai/dsh-goal-round-driver')
  // Use a read-only upstream source snapshot, copied to the isolated fixture.
  // Its imports are only parsed (--check), never evaluated.
  const acpSource = await fs.readFile(require.resolve('@deepseek-ai/dsh-acp'), 'utf8')
  const llmSource = await fs.readFile(require.resolve('@deepseek-ai/dsh-llm-pi-ai'), 'utf8')
  const acp = await put(`${acpDir}/lib/index.js`, acpSource)
  const llm = await put(`${llmDir}/lib/index.js`, llmSource)
  const searchSource = await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-fs-search'), 'utf8')
  const search = await put(`${searchDir}/lib/index.js`, searchSource)
  const goalToolSource = await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-goal'), 'utf8')
  const goalTool = await put(`${goalToolDir}/lib/index.js`, goalToolSource)
  const goalDriverSource = await fs.readFile(require.resolve('@deepseek-ai/dsh-goal-round-driver'), 'utf8')
  const goalDriver = await put(`${goalDriverDir}/lib/index.js`, goalDriverSource)
  const pi = await pkg('@earendil-works/pi-ai', 'dist/index.js', {
    exports: { '.': './dist/index.js', './utils/*': './dist/utils/*.js', './api/*': './dist/api/*.js' },
  })
  for (const api of ['anthropic-messages', 'openai-codex-responses', 'openai-responses']) {
    await put(`${pi}/dist/api/${api}.js`, 'export const stream = (model, context, options) => options?.onPayload?.({}, model); export const streamSimple = stream;')
    await put(`${pi}/dist/api/${api}.lazy.js`, `export const api = () => import("./${api}.js")`)
  }
  await put(`${pi}/dist/providers/opencode-go.models.js`, 'import values from "./data/opencode-go.json" with { type: "json" }; export const OPENCODE_GO_MODELS = values')
  await put(`${pi}/dist/providers/data/opencode-go.json`, JSON.stringify({ 'openai-completions': { 'chat:fixture': { id: 'fixture', type: 'chat' } } }))
  const retry = await put(`${pi}/dist/utils/retry.js`, 'export const isRetryableAssistantError = () => true')
  return { root, put, acp, llm, search, goalTool, goalDriver, acpSource, llmSource, searchSource, goalToolSource, goalDriverSource, retry, pi }
}

test('compatibility uses runtime hook registration order, not reversed load entry order', async (t) => {
  const { acpSource, llmSource, searchSource, goalToolSource, goalDriverSource } = await fixture(t)
  assert.deepEqual(runtimeHookArgs().filter((arg) => arg !== '--import').map((url) => path.basename(new URL(url).pathname)), [
    'fast-mode-hook.js', 'opencode-catalog-hook.js', 'steer-hook.js', 'retry-hook.js', 'goal-hook.js', 'goal-wait-hook.js', 'goal-tool-hook.js', 'mcp-timeout-hook.js', 'output-speed-hook.js', 'ptc-hook.js', 'fs-search-hook.js',
  ])
  assert.deepEqual(composeCompatibilityPatches({ acp: acpSource, llm: llmSource, search: searchSource, goalTool: goalToolSource, goalDriver: goalDriverSource }), {
    acp: patchPtcSource(patchOutputSpeedSource(patchMcpTimeoutSource(patchGoalSource(patchAcpSource(acpSource))))), llm: patchRetrySource(llmSource), search: patchFsSearchSource(searchSource), goalTool: patchGoalToolSource(goalToolSource), goalDriver: patchGoalDriverSource(goalDriverSource),
  })
})

test('fresh check process requires compatibility before its mock startup/model checks', async (t) => {
  const { root } = await fixture(t)
  const report = await verifyInstall({ root, timeoutMs: 30_000 })
  assert.equal(report.ok, true)
  assert.equal(report.compatibility.ok, true)
  assert.equal(report.models, 1)
  assert.equal(await fs.readFile(path.join(root, 'runtime-started'), 'utf8'), 'yes')
})

test('a catalog format warning blocks the update before the runtime starts', async (t) => {
  const { root, put } = await fixture(t)
  await put('server/model-catalog.js', 'export const ensureModelCatalog = async () => ({ warnings: ["unsupported catalog layout"] })')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /model catalog: unsupported catalog layout/)
  await assert.rejects(fs.stat(path.join(root, 'runtime-started')))
})

for (const [name, field, change] of [
  ['steer', 'acp', (source) => source.replace('a prompt is already in flight for this session', 'upstream changed admission')],
  ['goal', 'acp', (source) => source.replace('settleAfterQuiescence(inflight) {', 'upstreamSettlement(inflight) {')],
  ['goal-wait', 'goalDriver', (source) => source.replace('function readyToDrive(state)', 'function changedReady(state)')],
  ['goal-tool', 'goalTool', (source) => source.replace('Replacement cap; valid only with action edit.', 'changed upstream cap')],
  ['retry', 'llm', (source) => source.replace('function classifyPiAiError(message)', 'function upstreamClassifier(message)')],
  ['output-speed', 'acp', (source) => source.replace('requestSignal?.removeEventListener', 'requestSignal?.upstreamRemoveEventListener')],
  ['ptc', 'acp', (source) => source.replace('return this.modelControl.set(configId, value, signal);', 'return upstreamSetConfig();')],
  ['fs-search', 'search', (source) => source.replace('async function runRipgrep(', 'async function upstreamSearch(')],
]) {
  test(`fresh verify rejects changed upstream ${name} fixture instead of accepting model-only success`, async (t) => {
    const f = await fixture(t)
    const source = await fs.readFile(f[field], 'utf8')
    const changed = change(source)
    assert.notEqual(changed, source)
    await fs.writeFile(f[field], changed)
    await assert.rejects(verifyInstall({ root: f.root, timeoutMs: 30_000 }), new RegExp(`${name} hook: upstream source did not match`))
    await assert.rejects(fs.stat(path.join(f.root, 'runtime-started')))
    await assert.rejects(fs.stat(path.join(f.root, 'catalog-touched')))
  })
}

test('source matching alone cannot pass syntactically invalid composed modules', async (t) => {
  const { root, acp, acpSource } = await fixture(t)
  await fs.writeFile(acp, `${acpSource}\nexport const broken = ;`)
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /syntax check failed/)
})

test('a moved module entrypoint fails the hook URL contract', async (t) => {
  const { root, put } = await fixture(t)
  await put('node_modules/@deepseek-ai/dsh-acp/package.json', '{"type":"module","main":"changed.js"}')
  await put('node_modules/@deepseek-ai/dsh-acp/changed.js', 'export {}')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /entrypoint no longer matches/)
})

test('the actual nested dsh module is checked instead of a compatible hoisted copy', async (t) => {
  const { root, put } = await fixture(t)
  const nested = 'node_modules/@deepseek-ai/dsh-acp-app/node_modules/@deepseek-ai/dsh-acp'
  await put(`${nested}/package.json`, '{"type":"module","main":"lib/index.js"}')
  await put(`${nested}/lib/index.js`, 'export const changedUpstream = true')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /steer hook: upstream source did not match/)
})

test('the goal-tool gate checks the actual nested dependency owned by dsh-base', async (t) => {
  const { root, put } = await fixture(t)
  const nested = 'node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-tool-goal'
  await put(`${nested}/package.json`, '{"type":"module","main":"lib/index.js"}')
  await put(`${nested}/lib/index.js`, 'export const changedUpstream = true')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /goal-tool hook: upstream source did not match/)
})

test('fast-mode missing payload interception cannot pass the update gate', async (t) => {
  const { root, pi, put } = await fixture(t)
  await put(`${pi}/dist/api/openai-codex-responses.js`, 'export const stream = () => {}; export const streamSimple = stream')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /fast-mode: openai-codex-responses no longer calls onPayload/)
})

test('OpenCode catalog loader drift blocks the update before runtime startup', async (t) => {
  const { root, pi, put } = await fixture(t)
  await put(`${pi}/dist/providers/opencode-go.models.js`, 'export const OPENCODE_GO_MODELS = {}')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /opencode-catalog: model loader no longer imports/)
  await assert.rejects(fs.stat(path.join(root, 'runtime-started')))
})

test('fast-mode requires both callable stream exports', async (t) => {
  const { root, pi, put } = await fixture(t)
  await put(`${pi}/dist/api/anthropic-messages.js`, 'export const stream = (m,c,o) => o?.onPayload?.({},m)')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /must export stream and streamSimple/)
})

test('retry check export is mandatory, not merely an optional startup warning', async (t) => {
  const { root, retry } = await fixture(t)
  await fs.writeFile(retry, 'export const changedUpstream = true')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /isRetryableAssistantError is unavailable/)
})

for (const name of ['goal', 'goal-wait', 'goal-tool', 'ptc']) {
  test(`the gate observes actual ${name} hook transformations, not just standalone patch functions`, async (t) => {
    const { root } = await fixture(t)
    const hook = path.join(root, 'server', `${name}-hook.js`)
    const source = await fs.readFile(hook, 'utf8')
    await fs.writeFile(hook, source.replace('const TARGET = /', 'const TARGET = /never-match'))
    assert.notEqual(await fs.readFile(hook, 'utf8'), source)
    await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /actual runtime hook composition differs/)
  })
}

test('a private retry utility left on disk is not enough if its public export vanished', async (t) => {
  const { root, pi, put } = await fixture(t)
  await put(`${pi}/package.json`, JSON.stringify({ name: '@earendil-works/pi-ai', type: 'module', main: 'dist/index.js', exports: { '.': './dist/index.js' } }))
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }), /not defined by "exports"|not exported/)
})

test('verifyInstall rejects an old model-only success report without compatibility', async (t) => {
  const { root, put } = await fixture(t)
  await put('scripts/check-dsh.mjs', 'console.log(JSON.stringify({ok:true,models:3}))')
  await assert.rejects(verifyInstall({ root, timeoutMs: 30_000 }))
})
