import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { patchAcpSource, STEER_META, STEERED_META } from '../server/steer-patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The dsh-acp module the installed dsh loads. */
function installedAcp() {
  const dshRequire = createRequire(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
  const dir = path.dirname(dshRequire.resolve('@deepseek-ai/dsh-acp/package.json'))
  return path.join(dir, 'lib/index.js')
}

test('the installed dsh-acp takes the steering patch, and still parses', () => {
  const source = fs.readFileSync(installedAcp(), 'utf8')
  const patched = patchAcpSource(source)
  assert.ok(patched, 'dsh-acp no longer matches steer-patch.js; update the patch for this dsh')
  assert.ok(patched.includes(`params._meta?.[${JSON.stringify(STEER_META)}] === true`))
  assert.ok(patched.includes('this.agent.steer('))
  assert.ok(patched.includes(JSON.stringify(STEERED_META)))
  // The steer branch comes before the "already in flight" refusal it bypasses.
  assert.ok(patched.indexOf('this.agent.steer(') < patched.indexOf('a prompt is already in flight'))
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-steer-')), 'index.mjs')
  try {
    fs.writeFileSync(file, patched)
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('uses the names the bundler gave, and leaves an unexpected dsh-acp alone', () => {
  const source = fs.readFileSync(installedAcp(), 'utf8')
  const renamed = patchAcpSource(source.replace(/\bcreateUserMessage\b/g, 'createUserMessage$2'))
  assert.ok(renamed?.includes('this.agent.steer(createUserMessage$2('))
  assert.equal(patchAcpSource('export const nothing = 1'), null)
  assert.equal(patchAcpSource(source.replace('a prompt is already in flight for this session', 'busy')), null)
})

for (const abortDuringAdmission of [false, true]) {
  test(`steering rejects an aborted prompt (${abortDuringAdmission ? 'during admission' : 'already cancelled'})`, async () => {
    const source = `async prompt(params, imageEnabled, requestSignal) {
      if (this.inflight !== void 0) throw invalidParams("a prompt is already in flight for this session");
      const content = await admit(this.ctx, promptSelection, params.prompt, imageEnabled, admissionController.signal);
      const message = userMessage({ content, source: { kind: "user" } });
    }`
    const admission = Promise.withResolvers()
    const Bridge = new Function('admit', `const invalidParams = (s) => new Error(s); const userMessage = (m) => m;
      return class { ${patchAcpSource(source)} }`)(() => admission.promise)
    const bridge = new Bridge()
    bridge.inflight = { admissionController: new AbortController() }
    let steered = false
    bridge.agent = { status: 'running', steer: () => { steered = true } }
    bridge.modelControl = { snapshot: () => ({}) }
    if (!abortDuringAdmission) bridge.inflight.admissionController.abort()
    const prompt = bridge.prompt({ _meta: { [STEER_META]: true }, prompt: [] }, true)
    if (abortDuringAdmission) bridge.inflight.admissionController.abort()
    admission.resolve([])
    await assert.rejects(prompt, /steer-unavailable/)
    assert.equal(steered, false)
  })
}
