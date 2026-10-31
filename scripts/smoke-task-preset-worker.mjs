// Explicit billed integration check; uses only disposable code and specified low-tier models.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AcpRuntime } from '../server/runtime.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { appPaths } from '../server/paths.js'
import { readJson } from '../server/json-file.js'
import { writeTaskPresetPatch } from '../server/dsh-config.js'
import { newTurn, applyUpdate, parseConfigOptions } from '../server/transcript.js'
import { ClaudeRunner } from '../server/claude-runner.js'
import { abClaudeArgs } from '../server/ab-runner.js'
import { authDescriptor, claudeAuthStatus } from '../server/claude-auth.js'
import { findClaude } from '../server/terminals.js'
import { workerPresetInstructions, parsePresetResult } from '../server/task-preset-protocol.js'
const provider = process.argv[2]
const permissionMode = process.argv.includes('--full-access') ? 'danger-full-access' : 'workspace-write'
if (!['gpt', 'claude'].includes(provider)) throw new Error('Usage: node scripts/smoke-task-preset-worker.mjs gpt|claude (billed)')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-worker-live-'))
const workspace = path.join(root, 'project')
await fs.mkdir(workspace)
await fs.writeFile(path.join(workspace, 'source.cjs'), 'exports.add = (a, b) => a - b\n')
await fs.writeFile(path.join(workspace, 'source.test.cjs'), 'const test = require("node:test"); const assert = require("node:assert/strict"); const { add } = require("./source.cjs"); test("sum", () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 2), 0) });\n')
const run = { id: randomUUID(), kind: provider === 'gpt' ? 'delegate' : 'review' }
const prompt = workerPresetInstructions(run) + '\n\nRequirements: add(a,b) must return their arithmetic sum. Scope: source.cjs and source.test.cjs only. ' + (run.kind === 'review' ? 'Independently review both files, fix discovered defects, and verify the fix.' : 'Implement the agreed sum behavior and verify it.') + ' Run node --test source.test.cjs. Do not run git commands, delegate, change settings, touch any other files, or start goals. Return the required final JSON with actual verification evidence.'
let rejectDeadline
const deadline = new Promise((_, reject) => { rejectDeadline = reject })
void deadline.catch(() => {})
const timeout = setTimeout(() => rejectDeadline(new Error('Worker smoke timed out')), 180000)
try {
  let output
  if (provider === 'gpt') {
    const paths = appPaths()
    const settings = await readJson(path.join(paths.home, 'settings.json'), {})
    const patch = path.join(root, 'preset.patch.yml')
    const subagents = Object.entries(settings.subagentModels ?? {}).filter(([, model]) => model).map(([provider, model]) => ({ provider, model }))
    await writeTaskPresetPatch(patch, { subagents })
    const turn = newTurn({ id: randomUUID(), text: prompt, images: [] })
    const runtime = new AcpRuntime({ mode: permissionMode, paths, patches: [patch], onUpdate: (_id, update) => applyUpdate(turn, update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    try {
      await runtime.start()
      const session = await runtime.newSession(workspace, [])
      const toolOptions = await runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, 'ptc')
      assert.equal(toolOptions.find((option) => option.id === TOOL_MODE_CONFIG)?.currentValue, 'ptc')
      const model = JSON.stringify(['openai-codex', 'gpt-6-luna'])
      assert.equal(parseConfigOptions(await runtime.setOption(session.sessionId, 'model', model)).currentModel, model)
      assert.equal(parseConfigOptions(await runtime.setOption(session.sessionId, 'reasoning_effort', 'low')).currentEffort, 'low')
      await Promise.race([runtime.prompt(session.sessionId, [{ type: 'text', text: prompt }]), deadline])
      output = turn.items.filter((item) => item.type === 'agent').at(-1)?.text
    } finally { await runtime.stop() }
  } else {
    const descriptor = authDescriptor(await claudeAuthStatus({ claude: findClaude(), cwd: workspace }))
    assert.equal(descriptor.mode, 'subscription', 'No model call on an unconfirmed billing route')
    const runner = await new ClaudeRunner({ dir: path.join(root, 'runner') }).load()
    try {
      const session = await runner.create({ workspace, model: 'haiku', effort: 'low', args: abClaudeArgs({ writable: true, instructions: workerPresetInstructions(run) }) })
      const done = new Promise((resolve) => runner.once('finished', resolve))
      runner.run(session.id, prompt)
      const event = await Promise.race([done, deadline])
      assert.equal(event.status, 'done', event.error)
      assert.equal(event.denials?.length ?? 0, 0)
      output = event.text
    } finally { await runner.shutdown() }
  }
  const result = parsePresetResult(output, run)
  assert.equal(result.status, 'complete', result.blocker || result.remaining)
  const check = await promisify(execFile)(process.execPath, ['--test', 'source.test.cjs'], { cwd: workspace, encoding: 'utf8', timeout: 10000 })
  assert.match(check.stdout, /pass 1/)
  console.log(JSON.stringify({ provider, model: provider === 'gpt' ? 'gpt-6-luna' : 'haiku', effort: 'low', permissionMode: provider === 'gpt' ? permissionMode : 'danger-full-access', role: run.kind, status: result.status, verification: 'passed', files: await fs.readdir(workspace) }))
} finally {
  clearTimeout(timeout)
  assert.ok(path.basename(root).startsWith('preset-worker-live-') && path.dirname(root) === os.tmpdir())
  await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
}
