import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXECUTION_PROMPT, executionPrompt, PLAN_IMPLEMENT_PROMPT } from '../server/execution.js'
import { executionTask } from '../server/teams-prompts.js'

test('eco delegates costly exploration without fixing strategy or review count', () => {
  assert.match(EXECUTION_PROMPT, /usually delegate investigation and implementation/)
  assert.match(EXECUTION_PROMPT, /interpreting the request, choosing direction and scope, and reviewing evidence/)
  assert.match(EXECUTION_PROMPT, /Choose investigation depth, planning detail and review needs for the task/)
  assert.match(EXECUTION_PROMPT, /rather than following a fixed sequence or review count/)
  assert.match(EXECUTION_PROMPT, /Inspect source when needed for a decision/)
  assert.match(EXECUTION_PROMPT, /batch related questions or instructions/)
  assert.match(EXECUTION_PROMPT, /Do small fixes directly only when you already have the evidence/)
})

test('both eco workflows use evidence and focused verification with their existing review limits', () => {
  for (const prompt of [executionPrompt(false), executionPrompt(true)]) {
    assert.match(prompt, /review concerns as hypotheses.*triggering conditions, concrete impact and evidence/)
    assert.match(prompt, /Do not require unsafe reproduction.*report significant risks/)
    assert.match(prompt, /checks not performed as unverified/)
    assert.match(prompt, /focus verification on resolving that issue and related regressions/)
    assert.match(prompt, /reverify when it is stale/)
    assert.match(prompt, /do not keep reviewing merely to eliminate findings/)
    assert.match(prompt, /Do not ignore newly discovered important risks/)
  }
  assert.match(PLAN_IMPLEMENT_PROMPT, /Do not perform a second review/)
  assert.match(PLAN_IMPLEMENT_PROMPT, /final changes were not parent-reviewed/)
})

test('eco child sees exact command IDs and working directories without mutating captured checks', () => {
  const checks = [
    { id: 'test', command: 'npm test -- --grep "再現"', autoRepair: false },
    { id: 'build', cwd: 'web', command: 'npm run build\nnode -e "console.log(1)"' },
  ]
  const execution = { mode: 'write', criteria: '元の不具合を直す', checks }
  const before = structuredClone(execution)
  const prompt = executionTask('この範囲を修正', execution)
  const commands = prompt.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
  assert.deepEqual(commands, checks.map(({ id, cwd = '.', command }) => ({ id, cwd, command })))
  assert.deepEqual(execution, before)
  assert.ok(prompt.startsWith('この範囲を修正\n\n[eco 完了条件]\n元の不具合を直す'))
  assert.match(prompt, /再現・対象を絞った回帰確認を優先/)
  assert.match(prompt, /全体テストが必要なら実行/)
  assert.match(prompt, /バックグラウンドの書き込み処理は残さず/)
  assert.match(prompt, /発生条件・具体的な影響と根拠/)
  assert.match(prompt, /その解消と関連する回帰/)
  assert.match(prompt, /危険な再現をせず根拠と未確認点/)
  assert.match(prompt, /新しい改善点を探し続けず終了/)
})

test('no selected app checks means unverified, not no need for child verification', () => {
  const prompt = executionTask('実装', { mode: 'write', criteria: '依頼の充足', checks: [] })
  assert.match(prompt, /検証コマンドはありません（未実行扱い）/)
  assert.match(prompt, /依頼に必要な確認を行い/)
  assert.doesNotMatch(prompt, /報告後にアプリが上記を実行/)
})

test('research asks for evidence and a proposal when supported without promising command verification', () => {
  const prompt = executionTask('原因調査だけ', { mode: 'research', criteria: '根拠を示す', checks: [] })
  assert.match(prompt, /読み取り専用の調査/)
  assert.match(prompt, /確認した事実と根拠、残る不明点を短く報告/)
  assert.match(prompt, /根拠が十分なら実装方針・検証案も添え、不十分なら推測で埋めない/)
  assert.match(prompt, /実装は行いません/)
  assert.match(prompt, /アプリのコマンド検証は行いません/)
  assert.doesNotMatch(prompt, /アプリの最終検証|報告後にアプリが上記を実行/)
})

test('ordinary TM tasks retain their original message', () => {
  const task = '通常チームの依頼\n改行もそのまま'
  assert.equal(executionTask(task), task)
})
