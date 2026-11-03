import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandCodeStatus, commandCodeEmptyHint } from '../web/src/command-code-status.ts'

const ok = { checkedAt: 10, checking: false, error: false, skipped: 0, applied: true, applyError: false }

test('Command Code status distinguishes key, checking, fetch, apply and visibility states', () => {
  assert.equal(commandCodeStatus(false, true, ok).kind, 'unconfigured')
  assert.equal(commandCodeStatus(true, true, null).kind, 'unverified')
  assert.equal(commandCodeStatus(true, true, { ...ok, checking: true }).kind, 'checking')
  assert.equal(commandCodeStatus(true, true, { ...ok, error: true }).kind, 'error')
  assert.equal(commandCodeStatus(true, true, { ...ok, applyError: true, applied: false }).kind, 'apply-error')
  assert.equal(commandCodeStatus(true, true, { ...ok, applied: false }).kind, 'pending')
  assert.equal(commandCodeStatus(true, true, { ...ok, skipped: 2 }).kind, 'partial')
  assert.equal(commandCodeStatus(true, false, ok).kind, 'manual')
  assert.equal(commandCodeStatus(true, true, ok).kind, 'ready')
  assert.notEqual(commandCodeStatus(true, false, { ...ok, error: true }).kind, 'ready')
})

test('empty picker explains the actual status without suggesting the key was verified', () => {
  assert.match(commandCodeEmptyHint(false, true, null), /API キーを登録/)
  assert.match(commandCodeEmptyHint(true, true, { ...ok, applied: false }), /反映待ち/)
  assert.match(commandCodeEmptyHint(true, true, { ...ok, applyError: true }), /反映に失敗/)
  assert.match(commandCodeEmptyHint(true, true, { ...ok, error: true }), /取得に失敗/)
  assert.match(commandCodeEmptyHint(true, false, ok), /表示を確認/)
})
