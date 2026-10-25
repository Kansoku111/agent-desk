import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ExecutionReview } from '../server/execution-review.js'
import { ExecutionVerifier } from '../server/execution.js'

async function fixture(t, { git = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-review-'))
  const folder = path.join(root, 'project')
  await fs.mkdir(folder)
  const command = (...args) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' })
  if (git) command('init', '-q')
  await fs.writeFile(path.join(folder, 'source.txt'), 'original\n')
  await fs.writeFile(path.join(folder, '.gitignore'), 'output/\n')
  const verifier = await new ExecutionVerifier({ dir: path.join(root, 'execution') }).load()
  const reviews = new ExecutionReview({ dir: path.join(root, 'reviews') })
  t.after(async () => { await verifier.stop(); await fs.rm(root, { recursive: true, force: true }) })
  const execution = { task: '直す対象と目的', criteria: '無関係な変更をしない', baseline: await reviews.start(folder, 'child') }
  const report = async (childReport = 'done') => {
    const run = await verifier.verify({ id: 'child', folder, checks: [] })
    return { run, ...await reviews.report({ folder, execution, run, childReport }) }
  }
  return { folder, command, verifier, reviews, execution, report }
}

test('eco reviews use the actual dirty baseline, including untracked/deleted files and child commits', async (t) => {
  const f = await fixture(t)
  const { folder, command, reviews, execution, report } = f
  const commit = () => command('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test')
  command('add', '.')
  commit()
  await fs.writeFile(path.join(folder, 'source.txt'), 'user dirty version\n')
  await fs.writeFile(path.join(folder, 'user-only.txt'), 'pre-existing untracked\n')
  command('add', 'source.txt')
  const index = command('diff', '--cached')
  const head = command('rev-parse', 'HEAD')
  execution.baseline = await reviews.start(folder, 'child')
  assert.equal(command('diff', '--cached'), index)
  assert.equal(command('rev-parse', 'HEAD'), head)
  await fs.writeFile(path.join(folder, 'source.txt'), 'child fix\n')
  await fs.rm(path.join(folder, 'user-only.txt'))
  await fs.writeFile(path.join(folder, '追加 file.txt'), 'new file\n')
  command('add', '.')
  commit()
  const result = await report('source.txtを修正')
  const patch = await fs.readFile(result.patch, 'utf8')
  assert.match(patch, /-user dirty version/)
  assert.match(patch, /\+child fix/)
  assert.doesNotMatch(patch, /-original/)
  assert.match(patch, /-pre-existing untracked/)
  assert.match(patch, /\+new file/)
  assert.match(result.text, /D "user-only.txt"/)
  assert.match(result.text, /追加 file.txt/)
  assert.match(result.text, /直す対象と目的/)
  assert.match(result.text, /無関係な変更をしない/)
  assert.match(result.text, /eco 検証: unverified/)
  assert.match(result.text, /source.txtを修正/)
  assert.equal(result.warning, null)
})

test('eco review captures plain folders, binaries and no-change reports without claiming verification', async (t) => {
  const { folder, report } = await fixture(t, { git: false })
  const unchanged = await report()
  assert.match(unchanged.text, /変更なし/)
  assert.match(unchanged.text, /eco 検証: unverified/)
  await fs.writeFile(path.join(folder, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  const binary = await report()
  assert.match(await fs.readFile(binary.patch, 'utf8'), /Binary files/)
  assert.match(binary.text, /A "binary.bin"/)
  assert.match(binary.text, /バイナリは内容を別途確認/)
})

test('eco review previews are bounded while full requests, instructions, patches and child reports remain available', async (t) => {
  const { folder, execution, report } = await fixture(t)
  execution.task = 'task'.repeat(3000) + 'TASK-END'
  execution.instructions = ['first followup', 'followup'.repeat(2000) + 'FOLLOWUP-END']
  await fs.writeFile(path.join(folder, 'source.txt'), Array.from({ length: 2000 }, (_, n) => `line ${n}`).join('\n') + '\nPATCH-END\n')
  const result = await report('report'.repeat(3000) + 'REPORT-END')
  assert.ok(result.text.length < 40_000)
  assert.match(result.text, /差分抜粋/)
  assert.match(result.text, /資料全文:/)
  assert.doesNotMatch(result.text, /TASK-END|FOLLOWUP-END|PATCH-END|REPORT-END/)
  const full = await fs.readFile(result.record, 'utf8')
  assert.match(full, /TASK-END/)
  assert.match(full, /FOLLOWUP-END/)
  assert.match(full, /REPORT-END/)
  assert.match(await fs.readFile(result.patch, 'utf8'), /PATCH-END/)
})

test('eco missing baseline and failed snapshots are explicit unknown evidence, not empty diffs', async (t) => {
  const { reviews, execution, report, folder } = await fixture(t)
  reviews.checkpoints.snapshot = async () => { throw new Error('snapshot unavailable') }
  const failed = await reviews.start(folder, 'next')
  assert.match(failed.error, /snapshot unavailable/)
  execution.baseline = failed
  const result = await report()
  assert.equal(result.patch, null)
  assert.match(result.text, /差分取得失敗: snapshot unavailable/)
  assert.match(result.text, /不明（変更なしを意味しません）/)
  delete execution.baseline
  assert.match((await report()).text, /作業開始前の記録がありません/)
})

test('eco review surfaces oversized omitted files without reporting a false deletion', async (t) => {
  const { folder, reviews, execution, report } = await fixture(t)
  reviews.checkpoints.maxFileBytes = 32
  // A fresh instance applies this limit to the repo created by the fixture.
  reviews.checkpoints.repos.clear()
  execution.baseline = await reviews.start(folder, 'child')
  await fs.writeFile(path.join(folder, 'source.txt'), 'x'.repeat(64))
  const result = await report()
  assert.match(result.warning, /差分対象外: "source.txt"/)
  assert.doesNotMatch(result.text, /D "source.txt"/)
})

test('eco review preserves infrastructure errors when verification has no ending fingerprint', async (t) => {
  const { folder, reviews, execution, verifier } = await fixture(t)
  const run = await verifier.verify({ id: 'child', folder, checks: [] })
  run.status = 'error'
  run.error = 'verification could not read source'
  delete run.endHash
  const review = await reviews.report({ folder, execution, run, childReport: 'done' })
  assert.equal(run.status, 'error')
  assert.match(review.text, /eco 検証: error/)
  assert.match(review.text, /verification could not read source/)
})

test('eco changes while recording the review invalidate the command evidence', async (t) => {
  const { folder, reviews, report } = await fixture(t)
  const diff = reviews.checkpoints.reviewDiff.bind(reviews.checkpoints)
  reviews.checkpoints.reviewDiff = async (...args) => {
    const result = await diff(...args)
    await fs.writeFile(path.join(folder, 'source.txt'), 'external edit after snapshot\n')
    return result
  }
  const result = await report()
  assert.equal(result.run.status, 'stale')
  assert.match(result.warning, /差分の取得中にソースが変更/)
  assert.match(result.text, /eco 検証: stale/)
})
