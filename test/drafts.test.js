import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { getDraft, setDraft, useDraft } from '../web/src/drafts.ts'

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
