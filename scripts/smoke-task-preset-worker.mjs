// Explicit billed integration check; uses only disposable code and specified low-tier models.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RuntimePool } from '../server/runtime.js'
import { TOOL_MODE_CONFIG } from '../server/ptc.js'
import { appPaths } from '../server/paths.js'
import { readJson } from '../server/json-file.js'
import { writeTaskPresetPatch } from '../server/dsh-config.js'
import { routePlan, savedRoutes } from '../server/subagent-routes.js'
import { newTurn, applyUpdate, parseConfigOptions } from '../server/transcript.js'
import { ClaudeRunner } from '../server/claude-runner.js'
import { abClaudeArgs } from '../server/ab-runner.js'
import { authDescriptor, claudeAuthStatus } from '../server/claude-auth.js'
import { findClaude } from '../server/terminals.js'
import { workerPresetInstructions, parsePresetResult } from '../server/task-preset-protocol.js'
const provider = process.argv[2]
const opinion = process.argv.includes('--opinion')
const permissionMode = opinion ? 'read-only' : process.argv.includes('--full-access') ? 'danger-full-access' : 'workspace-write'
if (!['gpt', 'claude'].includes(provider) || opinion && provider !== 'gpt') throw new Error('Usage: node scripts/smoke-task-preset-worker.mjs gpt|claude [--full-access] (gpt also supports --opinion; billed)')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-worker-live-'))
const workspace = path.join(root, 'project')
await fs.mkdir(workspace)
await fs.writeFile(path.join(workspace, 'source.cjs'), 'exports.add = (a, b) => a - b\n')
await fs.writeFile(path.join(workspace, 'source.test.cjs'), 'const test = require("node:test"); const assert = require("node:assert/strict"); const { add } = require("./source.cjs"); test("sum", () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 2), 0) });\n')
const run = { id: randomUUID(), kind: opinion || provider === 'claude' ? 'review' : 'delegate', ...(opinion ? { reviewMode: 'opinion' } : {}) }
const prompt = workerPresetInstructions(run) + '\n\nRequirements: add(a,b) must return their arithmetic sum. Scope: source.cjs and source.test.cjs only. ' + (opinion ? 'Read both files and independently assess whether the implementation satisfies the requirement. Report the defect with evidence. Do not change files or run shell commands.' : (run.kind === 'review' ? 'Independently review both files, fix discovered defects, and verify the fix.' : 'Implement the agreed sum behavior and verify it.') + ' Run node --test source.test.cjs.') + ' Do not run git commands, delegate, change settings, touch any other files, or start goals. Return the required final JSON with actual verification evidence.'
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
    const { pinned } = routePlan('dsh', savedRoutes(settings).dsh)
    const subagents = pinned ? [pinned] : []
    await writeTaskPresetPatch(patch, { subagents })
    const turn = newTurn({ id: randomUUID(), text: prompt, images: [] })
    const pool = new RuntimePool({ paths: { ...paths, taskPresetPatch: patch }, onUpdate: (_id, update) => applyUpdate(turn, update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    try {
      const runtime = await pool.get('preset:' + permissionMode)
      const session = await runtime.newSession(workspace, [])
      const toolOptions = await runtime.setOption(session.sessionId, TOOL_MODE_CONFIG, 'ptc')
      assert.equal(toolOptions.find((option) => option.id === TOOL_MODE_CONFIG)?.currentValue, 'ptc')
      const model = JSON.stringify(['openai-codex', 'gpt-6-luna'])
      assert.equal(parseConfigOptions(await runtime.setOption(session.sessionId, 'model', model)).currentModel, model)
      assert.equal(parseConfigOptions(await runtime.setOption(session.sessionId, 'reasoning_effort', 'low')).currentEffort, 'low')
      await Promise.race([runtime.prompt(session.sessionId, [{ type: 'text', text: prompt }]), deadline])
      output = turn.items.filter((item) => item.type === 'agent').at(-1)?.text
    } finally { await pool.stopAll() }
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
  if (opinion) {
    assert.equal(await fs.readFile(path.join(workspace, 'source.cjs'), 'utf8'), 'exports.add = (a, b) => a - b\n')
    assert.equal(await fs.readFile(path.join(workspace, 'source.test.cjs'), 'utf8'), 'const test = require("node:test"); const assert = require("node:assert/strict"); const { add } = require("./source.cjs"); test("sum", () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 2), 0) });\n')
    assert.match(result.summary, /subtract|減算|引き算|a\s*-\s*b/i)
  } else {
    const check = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', 'source.test.cjs'], { cwd: workspace, encoding: 'utf8', timeout: 10000 })
    // The worker may add regression cases, so the number of passing tests is not fixed.
    assert.match(check.stdout, /^# pass [1-9]\d*$/m)
    assert.match(check.stdout, /^# fail 0$/m)
  }
  console.log(JSON.stringify({ provider, model: provider === 'gpt' ? 'gpt-6-luna' : 'haiku', effort: 'low', permissionMode: provider === 'gpt' ? permissionMode : 'danger-full-access', role: opinion ? 'opinion' : run.kind, status: result.status, verification: opinion ? 'reported without edits' : 'passed', files: await fs.readdir(workspace) }))
} finally {
  clearTimeout(timeout)
  assert.ok(path.basename(root).startsWith('preset-worker-live-') && path.dirname(root) === os.tmpdir())
  await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
}
