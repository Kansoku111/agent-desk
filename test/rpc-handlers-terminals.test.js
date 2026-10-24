import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'

test('terminal.send answers something other than null, which the page takes as a failure', async () => {
  const sent = []
  const handlers = createTerminalHandlers({ terminals: { sendMessage: async (id, text) => { sent.push([id, text]) } } })
  assert.notEqual(await handlers['terminal.send']({ terminalId: 't1', text: 'こんにちは' }) ?? null, null)
  assert.deepEqual(sent, [['t1', 'こんにちは']])
})
