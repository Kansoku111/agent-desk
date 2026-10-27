import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ExecutionVerifier, normalizeChecks, sourceSnapshot, EXECUTION_PROMPT, workspaceKey, workspaceWithin, workspacesOverlap } from '../server/execution.js'

test('eco leader reuses accepted research only through explicit implementation', () => {
  assert.match(EXECUTION_PROMPT, /research child is read-only even when you have full access/)
  assert.match(EXECUTION_PROMPT, /Omit sandbox_permissions and justification/)
  assert.match(EXECUTION_PROMPT, /close the research unit with accept:true and a reason, then use implement on that same child/)
  assert.match(EXECUTION_PROMPT, /send and fresh preserve the child's current mode/)
  assert.match(EXECUTION_PROMPT, /only one writer is allowed through verification and judgment/)
})

test('workspace aliases preserve overlap for descendants that do not exist yet', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-overlap-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  const alias = path.join(root, 'alias')
  await fs.mkdir(target)
  await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const missing = path.join(alias, 'missing', 'nested')
  assert.equal(workspaceKey(missing), workspaceKey(path.join(target, 'missing', 'nested')))
  assert.equal(workspaceWithin(target, missing), true)
  assert.equal(workspacesOverlap(missing, target), true)
  assert.equal(workspacesOverlap(missing, path.join(root, 'other')), false)
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ex-'))
  const folder = path.join(root, 'project')
  await fs.mkdir(folder)
  execFileSync('git', ['init', '-q', folder])
  await fs.writeFile(path.join(folder, 'source.txt'), 'before')
  await fs.writeFile(path.join(folder, '.gitignore'), 'output/\n')
  const verifier = await new ExecutionVerifier({ dir: path.join(root, 'records') }).load()
  t.after(async () => { await verifier.stop(); await fs.rm(root, { recursive: true, force: true }) })
  return { folder, root, verifier }
}

test('EX legacy saved models restore default efforts and invalid effort types are rejected', async (t) => {
  const { root } = await fixture(t)
  const dir = path.join(root, 'legacy')
  await fs.mkdir(dir)
  const models = { leader: 'claude:sonnet', provider: 'claude', model: 'haiku' }
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ models }))
  const restored = await new ExecutionVerifier({ dir }).load()
  assert.deepEqual(await restored.modelSelection(), { ...models, leaderEffort: '', childEffort: '', toolMode: 'native' })
  for (const patch of [{ leaderEffort: 1 }, { childEffort: [] }, { childEffort: 'x'.repeat(101) }]) await assert.rejects(restored.configureModels({ ...models, ...patch }), /推論レベル/)
})

test('EX remembers model selection before a task starts, across restart and reads during a save', async (t) => {
  const { root, verifier } = await fixture(t)
  assert.equal(await verifier.modelSelection(), null)
  const choice = { leader: 'claude:sonnet', provider: 'claudeApi', model: 'claude-haiku-5-5', leaderEffort: '', childEffort: '', toolMode: 'ptc' }
  const pending = verifier.configureModels(choice)
  const reread = verifier.modelSelection()
  choice.model = 'mutated-after-save'
  await pending
  assert.equal((await reread).model, 'claude-haiku-5-5')
  const restored = await new ExecutionVerifier({ dir: path.join(root, 'records') }).load()
  assert.deepEqual(await restored.modelSelection(), { leader: 'claude:sonnet', provider: 'claudeApi', model: 'claude-haiku-5-5', leaderEffort: '', childEffort: '', toolMode: 'ptc' })
  const copy = await restored.modelSelection()
  copy.leader = 'changed'
  assert.equal((await restored.modelSelection()).leader, 'claude:sonnet')
})

test('EX model saves are ordered and legacy browser migration never overwrites another device', async (t) => {
  const { verifier } = await fixture(t)
  const first = { leader: 'claude:sonnet', provider: 'claudeApi', model: '', leaderEffort: 'high', childEffort: 'low', toolMode: 'native' }
  const last = { ...first, model: 'claude-haiku-5-5', leaderEffort: 'medium', childEffort: 'high' }
  const one = verifier.configureModels(first)
  const two = verifier.configureModels(last)
  const migration = verifier.configureModels({ leader: 'claude:opus', provider: 'claude', model: 'haiku' }, true)
  await Promise.all([one, two, migration])
  assert.deepEqual(await verifier.modelSelection(), last)
  await assert.rejects(verifier.configureModels({ ...last, toolMode: 'invalid' }), /不明/)
  await assert.rejects(verifier.configureModels({ leader: null, provider: 'claude', model: 'haiku' }), /不正/)
  await assert.rejects(verifier.configureModels({ leader: '', provider: 'unknown', model: '' }), /不正/)
  assert.deepEqual(await verifier.modelSelection(), last)
})

test('EX supports plain project folders without Git and releases invalid requests', async (t) => {
  const { root, verifier } = await fixture(t)
  const folder = path.join(root, 'plain')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, 'main.js'), 'before')
  const before = await sourceSnapshot(folder)
  await fs.writeFile(path.join(folder, 'main.js'), 'after')
  assert.notEqual((await sourceSnapshot(folder)).hash, before.hash)
  await assert.rejects(verifier.verify({ id: 'same', folder, checks: [{ id: '', command: 'echo x' }] }))
  assert.equal(verifier.active.size, 0)
  const run = await verifier.verify({ id: 'same', folder, checks: [] })
  assert.equal(run.status, 'unverified')
})

test('EX checks reject duplicate IDs, escaping paths and invalid timeout', () => {
  assert.throws(() => normalizeChecks([{ id: 'x', command: 'echo x', cwd: '../' }]))
  assert.throws(() => normalizeChecks([{ id: 'x', command: 'echo x' }, { id: 'x', command: 'echo y' }]))
  assert.throws(() => normalizeChecks([{ id: 'x', command: 'echo x', timeoutMs: 0 }]))
  assert.equal(normalizeChecks([{ id: 'x', command: 'echo x' }])[0].autoRepair, false)
})

test('EX source mutation permission defaults off and the parent may correct reviewed work', () => {
  assert.equal(normalizeChecks([{ id: 'test', command: 'echo test' }])[0].allowSourceChanges, false)
  assert.equal(normalizeChecks([{ id: 'fmt', command: 'echo fmt', allowSourceChanges: 'true' }])[0].allowSourceChanges, false)
  assert.match(EXECUTION_PROMPT, /While a unit awaits judgment and all children are idle, you may make a small scoped correction/)
  assert.match(EXECUTION_PROMPT, /after any edit, call verify/)
  assert.doesNotMatch(EXECUTION_PROMPT, /or a verified result awaits judgment/)
  assert.match(EXECUTION_PROMPT, /what you will inspect for acceptance/)
  assert.match(EXECUTION_PROMPT, /Test success alone is never sufficient/)
  assert.match(EXECUTION_PROMPT, /reason is required even when checks pass or the task is research/)
  assert.match(EXECUTION_PROMPT, /for UI inspect the actual screen and interaction/)
})

test('EX attributes changes per check instead of allowing any change when a formatter is present', async (t) => {
  const { folder, verifier } = await fixture(t)
  const checks = [
    { id: 'fmt', allowSourceChanges: true, command: `node -e "require('fs').writeFileSync('source.txt','formatted')"` },
    { id: 'test', command: `node -e "require('fs').writeFileSync('source.txt','unexpected')"` },
  ]
  const run = await verifier.verify({ id: 'a', folder, checks })
  assert.equal(run.status, 'stale')
  assert.equal(run.canRerun, false)
  assert.ok(run.checks.every((check) => check.sourceChanged))
  const allowed = await verifier.verify({ id: 'b', folder, checks: [checks[0], { id: 'test', command: 'node -e "console.log(1)"' }] })
  assert.equal(allowed.canRerun, true)
})

test('EX snapshots include untracked content and ignore generated files', async (t) => {
  const { folder } = await fixture(t)
  const first = await sourceSnapshot(folder)
  await fs.writeFile(path.join(folder, 'source.txt'), 'after')
  assert.notEqual((await sourceSnapshot(folder)).hash, first.hash)
  await fs.writeFile(path.join(folder, 'source.txt'), 'before')
  await fs.mkdir(path.join(folder, 'output'))
  await fs.writeFile(path.join(folder, 'output', 'generated.txt'), 'generated')
  assert.equal((await sourceSnapshot(folder)).hash, first.hash)
})

test('EX persists checks per project and records actual command results', async (t) => {
  const { folder, root, verifier } = await fixture(t)
  const checks = [{ id: 'pass', command: 'node -e "console.log(123)"' }]
  await verifier.configure(folder, checks)
  const restored = await new ExecutionVerifier({ dir: path.join(root, 'records') }).load()
  assert.equal(restored.checks(folder)[0].id, 'pass')
  const run = await verifier.verify({ id: 'child', folder, checks })
  assert.equal(run.status, 'passed')
  assert.equal(run.checks[0].exitCode, 0)
  assert.match(await fs.readFile(run.checks[0].log, 'utf8'), /123/)
  assert.equal(JSON.parse(await fs.readFile(run.record, 'utf8')).sourceHash, run.sourceHash)
})

test('EX failure, timeout and empty checks are never reported as passing', async (t) => {
  const { folder, verifier } = await fixture(t)
  const fail = await verifier.verify({ id: 'a', folder, checks: [{ id: 'fail', command: 'node -e "process.exit(7)"' }] })
  assert.equal(fail.status, 'failed')
  assert.notEqual(fail.checks[0].exitCode, 0)
  const empty = await verifier.verify({ id: 'b', folder, checks: [] })
  assert.equal(empty.status, 'unverified')
  const timeout = await verifier.verify({ id: 'c', folder, checks: [{ id: 'timeout', command: 'node -e "setTimeout(()=>{},60000)"', timeoutMs: 1000 }] })
  assert.equal(timeout.status, 'failed')
  assert.equal(timeout.checks[0].status, 'timeout')
})

test('EX modifications during verification stale the result', async (t) => {
  const { folder, verifier } = await fixture(t)
  const run = await verifier.verify({ id: 'a', folder, checks: [{ id: 'modify', command: `node -e "require('fs').writeFileSync('source.txt','changed')"` }] })
  assert.equal(run.status, 'stale')
})

test('EX changes reverted during a command still invalidate verification', async (t) => {
  const { folder, verifier } = await fixture(t)
  const run = await verifier.verify({ id: 'a', folder, checks: [{ id: 'revert', command: `node -e "const fs=require('fs');fs.writeFileSync('source.txt','changed');fs.writeFileSync('source.txt','before')"` }] })
  assert.equal(run.sourceHash, run.endHash)
  assert.equal(run.status, 'stale')
  assert.equal(run.ownerId, 'a')
})

test('EX detects newly created and removed source files in Git and plain folders', async (t) => {
  const { folder, root, verifier } = await fixture(t)
  const plain = path.join(root, 'plain')
  await fs.mkdir(plain)
  await fs.writeFile(path.join(plain, 'source.txt'), 'before')
  const command = `node -e "const fs=require('fs');fs.writeFileSync('temporary.js','source');fs.unlinkSync('temporary.js')"`
  for (const [index, workspace] of [folder, plain].entries()) {
    const run = await verifier.verify({ id: 'temporary-' + index, folder: workspace, checks: [{ id: 'test', command }] })
    assert.equal(run.sourceHash, run.endHash)
    assert.equal(run.status, 'stale')
    assert.equal(run.checks[0].sourceChanged, true)
    assert.equal(run.canRerun, false)
    const allowed = await verifier.verify({ id: 'allowed-' + index, folder: workspace, checks: [{ id: 'test', command, allowSourceChanges: true }] })
    assert.equal(allowed.status, 'stale')
    assert.equal(allowed.canRerun, true)
  }
})

test('EX ignores temporary generated files according to Git and plain folder exclusions', async (t) => {
  const { folder, root, verifier } = await fixture(t)
  await fs.writeFile(path.join(folder, '.gitignore'), 'output/\n*.log\nsrc/generated/\n')
  const plain = path.join(root, 'plain')
  await fs.mkdir(plain)
  for (const workspace of [folder, plain]) {
    await fs.mkdir(path.join(workspace, 'src'))
    await fs.writeFile(path.join(workspace, 'src', 'source.js'), 'source')
  }
  const check = (dir, extra = '') => ({
    id: 'generated',
    command: `node -e "const fs=require('fs');fs.mkdirSync('${dir}',{recursive:true});fs.writeFileSync('${dir}/tmp.js','temporary');fs.rmSync('${dir}',{recursive:true});${extra}"`
  })
  const git = await verifier.verify({ id: 'git-ignored', folder, checks: [check('output', "fs.writeFileSync('tmp.log','log');fs.unlinkSync('tmp.log')")] })
  assert.equal(git.status, 'passed')
  assert.equal(git.checks[0].sourceChanged, false)
  const noGit = await verifier.verify({ id: 'plain-ignored', folder: plain, checks: [check('node_modules')] })
  assert.equal(noGit.status, 'passed')
  assert.equal(noGit.checks[0].sourceChanged, false)
  const nestedGit = await verifier.verify({ id: 'git-nested', folder, checks: [check('src/generated')] })
  const nestedPlain = await verifier.verify({ id: 'plain-nested', folder: plain, checks: [check('src/node_modules')] })
  assert.equal(nestedGit.status, 'passed')
  assert.equal(nestedPlain.status, 'passed')
})

test('EX does not confuse a file with an excluded directory of the same name', async (t) => {
  const { folder, root, verifier } = await fixture(t)
  const plain = path.join(root, 'plain')
  await fs.mkdir(plain)
  for (const [id, workspace, name] of [['git', folder, 'output'], ['plain', plain, 'node_modules']]) {
    const command = `node -e "const fs=require('fs');fs.writeFileSync('${name}','source');fs.unlinkSync('${name}')"`
    const run = await verifier.verify({ id, folder: workspace, checks: [{ id: 'test', command }] })
    assert.equal(run.status, 'stale')
    assert.equal(run.checks[0].sourceChanged, true)
  }
})

test('EX attributes new temporary source to its own check, not an allowed formatter', async (t) => {
  const { folder, verifier } = await fixture(t)
  const checks = [
    { id: 'fmt', allowSourceChanges: true, command: `node -e "require('fs').writeFileSync('source.txt','formatted')"` },
    { id: 'test', command: `node -e "const fs=require('fs');fs.mkdirSync('new-dir');fs.writeFileSync('new-dir/temp.js','source');fs.rmSync('new-dir',{recursive:true})"` },
  ]
  const run = await verifier.verify({ id: 'scoped', folder, checks })
  assert.equal(run.status, 'stale')
  assert.equal(run.canRerun, false)
  assert.ok(run.checks.every((check) => check.sourceChanged))
})

test('EX detects a temporary source file replacing a source directory', async (t) => {
  const { folder, verifier } = await fixture(t)
  await fs.mkdir(path.join(folder, 'src'))
  await fs.mkdir(path.join(folder, 'output'))
  await fs.writeFile(path.join(folder, 'src', 'code.js'), 'original')
  const command = `node -e "const fs=require('fs');fs.renameSync('src','output/backup');fs.writeFileSync('src','temporary');fs.unlinkSync('src');fs.renameSync('output/backup','src')"`
  const run = await verifier.verify({ id: 'directory', folder, checks: [{ id: 'test', command }] })
  assert.equal(run.sourceHash, run.endHash)
  assert.equal(run.status, 'stale')
  assert.equal(run.checks[0].sourceChanged, true)
})

test('EX accepts dot-prefixed child cwd and rejects a symlink escaping the project', async (t) => {
  const { folder, root, verifier } = await fixture(t)
  await fs.mkdir(path.join(folder, '..checks'))
  const external = path.join(root, 'outside')
  await fs.mkdir(external)
  await fs.symlink(external, path.join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const check = { id: 'test', command: 'node -e "console.log(1)"' }
  const inside = await verifier.verify({ id: 'inside', folder, checks: [{ ...check, cwd: '..checks' }] })
  assert.equal(inside.status, 'passed')
  const outside = await verifier.verify({ id: 'outside', folder, checks: [{ ...check, cwd: 'escape' }] })
  assert.equal(outside.status, 'error')
  assert.match(outside.error, /プロジェクト外/)
})

test('EX cancellation terminates verification and prevents later checks', async (t) => {
  const { folder, verifier } = await fixture(t)
  const pending = verifier.verify({ id: 'a', folder, checks: [{ id: 'slow', command: 'node -e "setTimeout(()=>{},60000)"' }, { id: 'next', command: 'echo next' }] })
  verifier.cancel('a')
  const run = await pending
  assert.equal(run.status, 'cancelled')
  assert.equal(run.checks.length, 0)
})
