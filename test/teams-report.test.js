import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reportMessage, reportText } from '../server/teams-report.js'

for (const execution of [false, true]) {
  for (const retained of [false, true]) {
    test('report delivery marks retrieval limits (eco=' + execution + ', retained=' + retained + ')', () => {
      const item = { id: 'report-1', childId: 'R', at: 1, kind: 'report', text: 'preview…', preview: true, truncated: true }
      const child = { id: 'R', name: 'R', title: 'work', reports: retained ? [{ at: 1, text: 'retained body longer than the preview' }] : [] }
      const text = reportMessage({ execution, children: [child], queue: [] }, item, () => 'model')
      assert.match(text, /保存上限の40,000文字で省略/)
      assert.match(text, /上限より先は取得できません/)
      if (retained) {
        assert.match(text, /保存済みの続きは read_report/)
        assert.doesNotMatch(text, /短縮版のみ/)
      } else {
        assert.match(text, /保持対象外のため短縮版のみ/)
        assert.doesNotMatch(text, /続きは read_report/)
      }
    })
  }
}

test('the queued final repair keeps its stage even after the child starts other work', () => {
  const item = { id: 'final-1', childId: 'R', at: 1, kind: 'report', text: 'final result', finalRepair: true, resent: true, truncated: false }
  const team = { execution: { planImplement: true }, children: [{ id: 'R', name: 'R', title: 'new work', reports: [] }], queue: [] }
  const text = reportMessage(team, item, () => 'model')
  assert.match(text, /最終修正は親レビュー未実施/)
  assert.match(text, /再レビューせず/)
  assert.doesNotMatch(text, /修正は send/)
  assert.match(text, /すでに受け取っていれば/)
})

test('legacy queued hints never promise full recovery of an evicted report', () => {
  const item = { id: 'legacy-1', childId: 'R', at: 1, kind: 'report', text: 'preview…\n（続きは read_report で読めます）' }
  const team = { children: [{ id: 'R', name: 'R', title: 'work', reports: [] }], queue: [] }
  const text = reportMessage(team, item, () => 'model')
  assert.match(text, /省略状態は不明/)
  assert.match(text, /保持対象外のため、キューに残る本文のみ/)
  assert.doesNotMatch(text, /続きは read_report|短縮版のみです/)
  assert.match(reportText(item, true), /省略状態は不明/)
})

test('an eco review preview already at the storage limit does not advertise more retained text', () => {
  const item = { id: 'review-1', childId: 'R', at: 1, kind: 'report', text: 'x'.repeat(40_000) + '…', preview: true, truncated: true }
  const team = { execution: {}, children: [{ id: 'R', name: 'R', title: 'work', reports: [{ ...item }] }], queue: [] }
  const text = reportMessage(team, item, () => 'model')
  assert.match(text, /保存上限の40,000文字で省略/)
  assert.doesNotMatch(text, /続きは read_report/)
})

test('legacy retained report bodies are not rewritten when removing old queued hints', () => {
  const text = 'original body\n（続きは read_report で読めます）'
  assert.ok(reportText({ text }).endsWith(text))
})

test('a complete short queued report remains complete even outside retention', () => {
  assert.equal(reportText({ text: 'complete', truncated: false, preview: false }, true), 'complete')
})
