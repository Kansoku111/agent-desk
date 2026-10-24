import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'

test('terminal.send answers something other than null, which the page takes as a failure', () => {
  const sent = []
  const handlers = createTerminalHandlers({ terminals: { sendMessage: (id, text) => sent.push([id, text]) } })
  assert.notEqual(handlers['terminal.send']({ terminalId: 't1', text: 'こんにちは' }) ?? null, null)
  assert.deepEqual(sent, [['t1', 'こんにちは']])
})
