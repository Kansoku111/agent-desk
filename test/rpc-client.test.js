import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcClient, RequestError, TransportError, requestErrorMessage } from '../web/src/rpc-client.ts'

test('an older server asks for a safe restart and other errors keep their detail', () => {
  assert.match(requestErrorMessage(new RequestError('unknown request: skills.list')), /作業が終わってから Agent Desk を起動し直し/)
  assert.equal(requestErrorMessage(new TransportError('サーバーに接続していません')), 'サーバーに接続していません')
  assert.equal(requestErrorMessage(new RequestError('一覧の取得に失敗')), '一覧の取得に失敗')
})

function socket() {
  const sent = []
  return { sent, readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
}

test('requests are correlated and server rejections differ from unknown delivery', async () => {
  const rpc = new RpcClient()
  const ws = socket()
  rpc.attach(ws)
  const success = rpc.request('example')
  rpc.receive({ id: ws.sent[0].id, ok: true, result: 42 }, ws)
  assert.equal(await success, 42)
  const failure = assert.rejects(rpc.request('example'), RequestError)
  rpc.receive({ id: ws.sent[1].id, ok: false, error: 'denied' }, ws)
  await failure
  assert.equal(rpc.receive({ event: 'thread' }, ws), false)
})

test('an old socket close or reply never cancels the replacement request', async () => {
  const rpc = new RpcClient()
  const old = socket(), current = socket()
  rpc.attach(old)
  const rejected = assert.rejects(rpc.request('old'), TransportError)
  rpc.attach(current)
  await rejected
  const pending = rpc.request('current')
  const id = current.sent[0].id
  rpc.detach(old)
  assert.equal(rpc.receive({ id, ok: true, result: 'stale' }, old), false)
  rpc.receive({ id, ok: true, result: 'right' }, current)
  assert.equal(await pending, 'right')
})

test('disconnect and synchronous send errors reject without leaking a pending request', async () => {
  const rpc = new RpcClient()
  await assert.rejects(rpc.request('offline'), TransportError)
  const ws = socket()
  rpc.attach(ws)
  const pending = assert.rejects(rpc.request('inflight'), TransportError)
  rpc.detach(ws)
  await pending
  rpc.attach({ readyState: 1, send() { throw new Error('socket closed') } })
  await assert.rejects(rpc.request('failing send'), TransportError)
})

test('timed out requests remain delivery-unknown and their late replies are harmless', async () => {
  const rpc = new RpcClient()
  const ws = socket()
  rpc.attach(ws)
  await assert.rejects(rpc.request('no reply', {}, 5), TransportError)
  assert.equal(rpc.receive({ id: ws.sent[0].id, ok: true, result: 'late' }, ws), true)
})
