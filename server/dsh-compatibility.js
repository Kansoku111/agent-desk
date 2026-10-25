// Strict update-only compatibility gate. Normal launch hooks deliberately warn
// and continue; installing a release must instead prove every required patch.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire, findPackageJSON, registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { patchAcpSource } from './steer-patch.js'
import { patchGoalSource } from './goal-patch.js'
import { patchMcpTimeoutSource } from './mcp-timeout-patch.js'
import { patchRetrySource } from './retry-patch.js'
import { patchOutputSpeedSource } from './output-speed-patch.js'
import { patchFsSearchSource } from './fs-search-patch.js'
import { patchGoalToolSource } from './goal-tool-patch.js'

// Both AcpRuntime and the verifier use this registration order. load hooks call
// nextLoad first, so their source transforms unwind in registration order (not
// the reverse order in which Node enters the hooks).
const HOOKS = [
  { name: 'fast-mode', module: null },
  { name: 'opencode-catalog', module: null },
  { name: 'steer', module: 'acp', patch: patchAcpSource },
  { name: 'retry', module: 'llm', patch: patchRetrySource },
  { name: 'goal', module: 'acp', patch: patchGoalSource },
  { name: 'goal-tool', module: 'goalTool', patch: patchGoalToolSource },
  { name: 'mcp-timeout', module: 'acp', patch: patchMcpTimeoutSource },
  { name: 'output-speed', module: 'acp', patch: patchOutputSpeedSource },
  { name: 'fs-search', module: 'search', patch: patchFsSearchSource },
]

export function runtimeHookArgs() {
  return HOOKS.flatMap(({ name }) => ['--import', new URL(`./${name}-hook.js`, import.meta.url).href])
}

export function composeCompatibilityPatches({ acp, llm, search, goalTool }) {
  const sources = { acp, llm, search, goalTool }
  for (const hook of HOOKS) {
    if (!hook.patch) continue
    const patched = hook.patch(sources[hook.module])
    if (!patched || patched === sources[hook.module]) throw new Error(`${hook.name} hook: upstream source did not match`)
    sources[hook.module] = patched
  }
  return sources
}

async function syntaxCheck(sources) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-compat-'))
  try {
    for (const [name, source] of Object.entries(sources)) {
      const file = path.join(dir, `${name}.mjs`)
      await fs.writeFile(file, source)
      await new Promise((resolve, reject) => {
        // --check parses without evaluating dsh or making provider requests.
        const child = spawn(process.execPath, ['--check', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let error = ''
        child.stderr.setEncoding('utf8').on('data', (chunk) => { error = (error + chunk).slice(-2000) })
        const timer = setTimeout(() => child.kill(), 15_000)
        child.on('error', (cause) => { clearTimeout(timer); reject(cause) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`${name}: patched module syntax check failed (${code}): ${error}`))
        })
      })
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function packageFile(specifier, parent) {
  const file = findPackageJSON(specifier, pathToFileURL(parent))
  if (!file) throw new Error(`cannot resolve ${specifier} from ${parent}`)
  return file
}

/** Resolve from the actual owning packages, not just the hoisted app copy. */
export function resolveCompatibilityModules(root) {
  const dsh = packageFile('@deepseek-ai/dsh', path.join(root, 'package.json'))
  const acpApp = packageFile('@deepseek-ai/dsh-acp-app', dsh)
  const base = packageFile('@deepseek-ai/dsh-base', dsh)
  const acp = createRequire(acpApp).resolve('@deepseek-ai/dsh-acp')
  const llm = createRequire(base).resolve('@deepseek-ai/dsh-llm-pi-ai')
  const search = createRequire(base).resolve('@deepseek-ai/dsh-tool-fs-search')
  const goalTool = createRequire(base).resolve('@deepseek-ai/dsh-tool-goal')
  // A changed entrypoint no longer matches the hooks' URL filters.
  for (const [file, name] of [[acp, 'dsh-acp'], [llm, 'dsh-llm-pi-ai'], [search, 'dsh-tool-fs-search'], [goalTool, 'dsh-tool-goal']]) {
    if (!file.replaceAll('\\', '/').endsWith(`/@deepseek-ai/${name}/lib/index.js`)) {
      throw new Error(`${name}: module entrypoint no longer matches the runtime hook: ${file}`)
    }
  }
  const pi = packageFile('@earendil-works/pi-ai', llm)
  // retry-hook imports the app's pi-ai, which may differ from dsh's nested copy.
  const retryPi = packageFile('@earendil-works/pi-ai', path.join(root, 'server', 'retry-hook.js'))
  return { acp, llm, search, goalTool, pi, retryPi }
}

async function verifyActualHookChain(modules, expected) {
  // This gate runs only in check-dsh's disposable fresh process. Load the real
  // hooks with exactly the same registration order as AcpRuntime, then observe
  // the result of their nextLoad chain. Do not evaluate any dsh module: replacing
  // its final source with an empty module prevents all upstream side effects.
  for (const { name } of HOOKS) await import(new URL(`./${name}-hook.js`, import.meta.url).href)
  const targets = new Map(['acp', 'llm', 'search', 'goalTool'].map((key) => [
    `${pathToFileURL(modules[key]).href}?agent-desk-compatibility`, key,
  ]))
  const seen = new Set()
  const observer = registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      const key = targets.get(url)
      if (!key) return result
      if (String(result.source) !== expected[key]) throw new Error(`${key}: actual runtime hook composition differs from compatibility patches`)
      seen.add(key)
      return { ...result, source: 'export {}' }
    },
  })
  try {
    for (const url of targets.keys()) await import(url)
    if (seen.size !== targets.size) throw new Error('runtime hook targets were not loaded')
  } finally {
    observer.deregister()
  }
}

/** Run in a fresh process: installs hooks, but never boots dsh or calls providers. */
export async function verifyDshCompatibility({ root = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  try {
    const modules = resolveCompatibilityModules(root)
    const sources = composeCompatibilityPatches({
      acp: await fs.readFile(modules.acp, 'utf8'),
      llm: await fs.readFile(modules.llm, 'utf8'),
      search: await fs.readFile(modules.search, 'utf8'),
      goalTool: await fs.readFile(modules.goalTool, 'utf8'),
    })
    const { isWrapped, wrapperSource } = await import('./fast-mode-hook.js')
    for (const api of ['anthropic-messages', 'openai-codex-responses', 'openai-responses']) {
      const file = path.join(path.dirname(modules.pi), 'dist', 'api', `${api}.js`)
      const url = pathToFileURL(file).href
      if (!isWrapped(url)) throw new Error(`fast-mode: ${api} no longer matches the runtime hook`)
      const source = await fs.readFile(file, 'utf8')
      const lazy = await fs.readFile(file.replace(/\.js$/, '.lazy.js'), 'utf8')
      // These are the minimum contracts the wrapper relies on. Do not require
      // the entire provider source to retain an exact upstream implementation.
      if (!/\bonPayload\s*(?:\?\.)?\s*\(/.test(source)) throw new Error(`fast-mode: ${api} no longer calls onPayload`)
      if (!lazy.includes(`import("./${api}.js")`) && !lazy.includes(`import('./${api}.js')`)) {
        throw new Error(`fast-mode: ${api} lazy entry no longer loads the wrapped module`)
      }
      sources[`fast-${api}`] = wrapperSource(url)
      sources[`api-${api}`] = source
    }
    const { isOpenCodeCatalog } = await import('./opencode-catalog-hook.js')
    const { openCodeModels } = await import('./opencode-go-catalog.js')
    const goDir = path.join(path.dirname(modules.pi), 'dist', 'providers')
    const goSource = await fs.readFile(path.join(goDir, 'opencode-go.models.js'), 'utf8')
    const goUrl = pathToFileURL(path.join(goDir, 'data', 'opencode-go.json')).href
    if (!isOpenCodeCatalog(goUrl) || !/import\s+\w+\s+from\s+["']\.\/data\/opencode-go\.json["']\s+with\s*\{\s*type:\s*["']json["']/.test(goSource)) {
      throw new Error('opencode-catalog: model loader no longer imports the overlaid JSON catalog')
    }
    const goData = JSON.parse(await fs.readFile(new URL(goUrl), 'utf8'))
    if (!openCodeModels(goData).length) throw new Error('opencode-catalog: no supported chat definitions')
    sources['opencode-models'] = goSource
    await syntaxCheck(sources)
    await verifyActualHookChain(modules, sources)

    // Import only provider definitions / retry utilities, never invoke streams.
    // Query bypasses a fast-mode hook if the caller has enabled it in its env.
    for (const api of ['anthropic-messages', 'openai-codex-responses', 'openai-responses']) {
      const url = pathToFileURL(path.join(path.dirname(modules.pi), 'dist', 'api', `${api}.js`)).href
      const exports = await import(`${url}?agent-desk-real`)
      if (typeof exports.stream !== 'function' || typeof exports.streamSimple !== 'function') {
        throw new Error(`fast-mode: ${api} must export stream and streamSimple`)
      }
    }
    // Resolve through the public export exactly as retry-hook does, not a
    // private file that might remain on disk after its public export vanished.
    const retryUrl = import.meta.resolve('@earendil-works/pi-ai/utils/retry')
    const retry = await import(retryUrl)
    if (typeof retry.isRetryableAssistantError !== 'function') throw new Error('retry hook: isRetryableAssistantError is unavailable')
    return { ok: true, hooks: HOOKS.map(({ name }) => name) }
  } catch (error) {
    throw new Error(`dsh compatibility: ${error.message}`, { cause: error })
  }
}
