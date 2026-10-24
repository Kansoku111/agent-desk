import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { getDraft, setDraft, useDraft, useImeField } from '../web/src/drafts.ts'

test('unsent text is kept per key and an emptied field forgets it', () => {
  setDraft('terminal:a', '書きかけ')
  setDraft('terminal:b', '別の下書き')
  assert.equal(getDraft('terminal:a'), '書きかけ')
  assert.equal(getDraft('terminal:b'), '別の下書き')
  assert.equal(getDraft('terminal:none'), '')
  setDraft('terminal:a', '')
  assert.equal(getDraft('terminal:a'), '')
})

test('a field that comes back to a key shows what was left there, and a new key never shows the old text', () => {
  setDraft('agent:1', '子への連絡')
  const Field = ({ id }) => createElement('i', null, useDraft(id)[0])
  assert.match(renderToString(createElement(Field, { id: 'agent:1' })), /子への連絡/)
  assert.doesNotMatch(renderToString(createElement(Field, { id: 'agent:2' })), /子への連絡/)
})

test('a send button confirms the IME text only while the field is composing', () => {
  let ime
  const Field = () => {
    ime = useImeField()
    return null
  }
  renderToString(createElement(Field))
  const calls = []
  ime.fieldProps.ref.current = { blur: () => calls.push('blur'), focus: () => calls.push('focus') }
  ime.confirm()
  assert.deepEqual(calls, [])
  ime.fieldProps.onCompositionStart()
  ime.confirm()
  assert.deepEqual(calls, ['blur', 'focus'])
  ime.fieldProps.onCompositionStart()
  ime.fieldProps.onCompositionEnd()
  ime.confirm()
  assert.deepEqual(calls, ['blur', 'focus'])
})
