import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RETRYABLE_KEY } from '../server/retry-patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the retry check comes from the pi-ai that dsh-llm-pi-ai itself resolves, not the app\'s own copy', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-retry-hook-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const put = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), text)
  }
  const piAi = async (base, answer) => {
    await put(`${base}/package.json`, JSON.stringify({ name: '@earendil-works/pi-ai', type: 'module', exports: { './utils/*': './dist/utils/*.js' } }))
    await put(`${base}/dist/utils/retry.js`, `export const isRetryableAssistantError = (message) => message.errorMessage === ${JSON.stringify(answer)}`)
  }
  const llm = 'node_modules/@deepseek-ai/dsh-llm-pi-ai'
  const dsh = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
  // The installed module, so the hook's patch applies as it does in a dsh process.
  await put(`${llm}/lib/index.js`, await fs.readFile(dsh.resolve('@deepseek-ai/dsh-llm-pi-ai'), 'utf8'))
  await put(`${llm}/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', type: 'module' }))
  await piAi(`${llm}/node_modules/@earendil-works/pi-ai`, 'nested')
  await piAi('node_modules/@earendil-works/pi-ai', 'hoisted')
  const target = pathToFileURL(path.join(dir, llm, 'lib/index.js')).href
  const script = `
    import { registerHooks } from 'node:module'
    const hook = await import(${JSON.stringify(pathToFileURL(path.join(root, 'server/retry-hook.js')).href)})
    // Registered last, so it sees the hook's patched source and keeps the module from being evaluated.
    let patched = false
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (url !== ${JSON.stringify(target)}) return result
      patched = String(result.source).includes(${JSON.stringify(RETRYABLE_KEY)})
      return { ...result, source: 'export {}' }
    } })
    const before = hook.engineRetryCheck()
    await import(${JSON.stringify(target)})
    const installed = await hook.engineRetryCheck()
    const check = globalThis[Symbol.for(${JSON.stringify(RETRYABLE_KEY)})]
    console.log(JSON.stringify({ before, patched, installed, nested: check?.('nested'), hoisted: check?.('hoisted') }))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(out), { before: null, patched: true, installed: true, nested: true, hoisted: false })
})
