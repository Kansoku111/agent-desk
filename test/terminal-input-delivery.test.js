import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendTerminalMessage } from '../web/src/terminal-send.ts'
import { RpcClient } from '../web/src/rpc-client.ts'

/** A field whose text and toasts are recorded, wired to a `send` the test controls. */
function field(initial, send) {
  const state = { text: initial, toasts: [], sent: [] }
  const delivery = {
    send: (text) => {
      state.sent.push(text)
      return send(text, state)
    },
    read: () => state.text,
    clear: () => { state.text = '' },
    fail: (message) => state.toasts.push(message),
  }
  return { state, run: () => sendTerminalMessage(delivery, initial) }
}

test('a message the server took empties the field, line breaks kept in what was sent', async () => {
  const { state, run } = field('一行目\n二行目', async () => ({ sent: true }))
  assert.equal(await run(), true)
  assert.deepEqual(state.sent, ['一行目\n二行目'])
  assert.equal(state.text, '')
  assert.deepEqual(state.toasts, [])
})

test('an old server answering null still counts as sent', async () => {
  const { state, run } = field('こんにちは', async () => null)
  assert.equal(await run(), true)
  assert.equal(state.text, '')
})

test('a rejected request keeps the text and shows the reason', async () => {
  const { state, run } = field('未送信の本文', async () => { throw new Error('サーバーに接続していません') })
  assert.equal(await run(), false)
  assert.equal(state.text, '未送信の本文')
  assert.deepEqual(state.toasts, ['サーバーに接続していません'])
})

test('text typed while the message was on its way is kept as the next message', async () => {
  const { state, run } = field('最初', async (_text, current) => { current.text = '最初の続き' })
  assert.equal(await run(), true)
  assert.equal(state.text, '最初の続き')
})

test('a disconnected client rejects, so nothing is cleared (real RpcClient)', async () => {
  const client = new RpcClient()
  const { state, run } = field('切断中の本文', (text) => client.request('terminal.send', { terminalId: 't', text }))
  assert.equal(await run(), false)
  assert.equal(state.text, '切断中の本文')
  assert.equal(state.toasts.length, 1)
  assert.match(state.toasts[0], /接続/)
})

test('an empty send (Enter only) reports a failure and clears nothing', async () => {
  const failed = field('', async () => { throw new Error('接続が切れました') })
  assert.equal(await failed.run(), false)
  assert.deepEqual(failed.state.toasts, ['接続が切れました'])
  const ok = field('', async () => ({ sent: true }))
  assert.equal(await ok.run(), true)
  assert.deepEqual(ok.state.sent, [''])
})
