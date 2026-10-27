import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { Outbox, readQueues } from '../web/src/outbox.ts'
import { RpcClient } from '../web/src/rpc-client.ts'
import { notificationRoute, notificationText } from '../web/src/notification.ts'
import * as turnUpdates from '../web/src/turn-updates.ts'
import * as createIntent from '../web/src/create-intent.ts'

async function fixture() {
  const source = await fs.readFile(new URL('../web/src/store.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const exports = {}
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  const sent = []
  let onSend
  let socket
  const require = (name) => {
    if (name === 'react') return {}
    if (name === './outbox') return { Outbox, readQueues }
    if (name === './rpc-client') return { RpcClient }
    if (name === './turn-updates') return turnUpdates
    if (name === './notification') return { notificationRoute, notificationText }
    if (name === './create-intent') return {
      beginCreateIntent: (fingerprint) => createIntent.beginCreateIntent(fingerprint, storage),
      completeCreateIntent: (id) => createIntent.completeCreateIntent(id, storage),
      createIntentFingerprint: createIntent.createIntentFingerprint,
    }
    throw new Error(`unexpected import: ${name}`)
  }
  class WebSocket {
    static CLOSING = 2
    readyState = 1
    constructor() { socket = this }
    send(data) {
      const request = JSON.parse(data)
      sent.push(request)
      onSend?.(request)
    }
  }
  const notifications = []
  class Notification {
    static permission = 'granted'
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this) }
  }
  const window = { matchMedia: () => ({ matches: false }), addEventListener() {}, Notification, focus() {} }
  const document = { addEventListener() {}, hidden: false }
  new Function('require', 'exports', 'location', 'sessionStorage', 'localStorage', 'history', 'window', 'document', 'WebSocket', 'Notification', outputText)(
    require, exports, { hostname: '127.0.0.1', href: 'http://127.0.0.1/?t=test', protocol: 'http:', host: '127.0.0.1' },
    storage, storage, { replaceState() {} }, window, document, WebSocket, Notification,
  )
  exports.connect()
  socket.onopen()
  const frame = (value) => socket.onmessage({ data: JSON.stringify(value) })
  const hello = () => frame({ event: 'hello', state: { app: { uiBuild: 'test' }, settings: {}, threads: [], terminals: [], teams: [] } })
  hello()
  return { store: exports, frame, hello, document, notifications, sent, storage, getSocket: () => socket, setOnSend: (callback) => { onSend = callback } }
}

test('AB browser notifications open AB, and the visible AB view suppresses duplicate alerts', async () => {
  const { store, frame, document, notifications } = await fixture()
  store.getState().server.settings.notifications = true
  const event = { event: 'notify', kind: 'ab-approval', ab: true, threadId: 'AB-run', title: '設計案' }
  store.setState({ route: { view: 'ab', id: 'AB-run' } })
  frame(event)
  assert.equal(notifications.length, 0)
  assert.equal(store.getState().toasts.length, 0)
  document.hidden = true
  store.setState({ route: { view: 'home' } })
  frame(event)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].options.body, /ABの案を確認/)
  notifications[0].onclick()
  assert.deepEqual(store.getState().route, { view: 'ab', id: 'AB-run' })
})

const turn = () => ({
  id: 'turn', status: 'running', startedAt: 1, endedAt: null, error: null, stopReason: null,
  user: { text: 'hello', images: [] },
  items: [
    { type: 'agent', id: 'answer', text: 'first' },
    { type: 'tool', id: 'tool', name: 'edit', status: 'in_progress', input: { path: 'a.txt', old_string: 'old', new_string: 'new' } },
  ],
})

for (const event of ['turnSpeed', 'agentTurnSpeed']) {
  test(`${event} updates speed, skips unchanged or missing turns, and removes speed`, async () => {
    const { store, frame } = await fixture()
    const field = event === 'turnSpeed' ? 'turns' : 'agentTurns'
    const send = (speed, turnId = 'turn', id = 'task') => frame({ event, ...(event === 'turnSpeed' ? { threadId: id } : { id }), turnId, speed })
    const previous = turn()
    const other = { ...turn(), id: 'other' }
    store.setState({ [field]: { task: [previous, other] } })
    const initial = store.getState()
    send(null)
    send(null, 'missing')
    send(null, 'turn', 'unloaded')
    assert.equal(store.getState(), initial)
    const speed = { tokensPerSecond: 12, state: 'streaming', estimated: true }
    send(speed)
    const updated = store.getState()
    assert.deepEqual(updated[field].task[0].outputSpeed, speed)
    assert.equal(updated[field].task[0].items, previous.items)
    assert.equal(updated[field].task[1], other)
    assert.equal(Object.hasOwn(previous, 'outputSpeed'), false)
    send(speed)
    assert.equal(store.getState(), updated)
    send(null)
    assert.equal(Object.hasOwn(store.getState()[field].task[0], 'outputSpeed'), false)
    assert.equal(store.getState()[field].task[1], other)
    assert.deepEqual(updated[field].task[0].outputSpeed, speed)
  })
}

for (const event of ['turn', 'agentTurn']) {
  test(`${event} preserves only unchanged objects and exposes nested, metadata, and item-order updates to memo`, async () => {
    const { store, frame } = await fixture()
    const field = event === 'turn' ? 'turns' : 'agentTurns'
    const send = (next) => frame({ event, ...(event === 'turn' ? { threadId: 'task' } : { id: 'task' }), turn: next })
    const current = () => store.getState()[field].task[0]
    const previous = turn()
    store.setState({ [field]: { task: [previous] } })
    send(previous)
    assert.equal(current(), previous)
    const next = structuredClone(previous)
    next.items[1].input.new_string = 'updated'
    next.items[1].status = 'completed'
    send(next)
    assert.notEqual(current(), previous)
    assert.equal(current().items[0], previous.items[0])
    assert.notEqual(current().items[1], previous.items[1])
    assert.equal(current().items[1].input.new_string, 'updated')
    assert.equal(previous.items[1].input.new_string, 'new')
    const shared = current()
    const finished = { ...next, status: 'done', endedAt: 2, user: { text: 'corrected', images: [] }, restore: { at: 2, files: 1, turns: 1, undo: 'snapshot' } }
    send(finished)
    assert.notEqual(current(), shared)
    assert.equal(current().items[1], shared.items[1])
    assert.equal(current().user.text, 'corrected')
    assert.equal(current().restore.undo, 'snapshot')
    const beforeIdentical = store.getState()[field].task
    send(finished)
    assert.equal(store.getState()[field].task, beforeIdentical)
    send({ ...finished, items: [...finished.items].reverse() })
    assert.equal(current().items[0], shared.items[1])
    send({ ...finished, items: [finished.items[0]] })
    assert.equal(current().items.length, 1)
  })
}

test('startThread retries a lost response with the same createId, then uses a fresh key for a new intent', async () => {
  const { store, frame, hello, sent, storage, getSocket, setOnSend } = await fixture()
  const draft = { workspace: 'C:/workspace', model: '[\"test\",\"model\"]', effort: '', permissionMode: 'workspace-write', toolMode: 'native' }
  store.setState({ draft })
  const accepted = new Map()
  let createCalls = 0
  setOnSend((request) => {
    if (request.type === 'thread.get') {
      frame({ id: request.id, ok: true, result: { thread: { id: request.threadId, workspace: draft.workspace }, turns: [] } })
      return
    }
    if (request.type !== 'thread.create') return
    let result = accepted.get(request.createId)
    if (!result) {
      result = { thread: { id: `created-${accepted.size + 1}`, workspace: draft.workspace, status: 'running', updatedAt: createCalls } }
      accepted.set(request.createId, result)
    }
    createCalls++
    if (createCalls > 1) frame({ id: request.id, ok: true, result })
  })

  const firstAttempt = store.startThread('same prompt', [])
  const firstRequest = sent.find((request) => request.type === 'thread.create')
  assert.ok(firstRequest?.createId)
  const firstSocket = getSocket()
  firstSocket.readyState = 3
  await firstSocket.onclose()
  assert.equal(await firstAttempt, false)

  store.connect()
  getSocket().onopen()
  hello()
  store.setState({ draft })
  const retryAttempt = store.startThread('same prompt', [])
  const createRequests = () => sent.filter((request) => request.type === 'thread.create')
  assert.equal(createRequests().length, 2)
  const retryRequest = createRequests()[1]
  assert.equal(retryRequest.createId, firstRequest.createId)
  assert.equal(await retryAttempt, true)
  assert.equal(store.getState().route.id, accepted.get(firstRequest.createId).thread.id)
  assert.equal(storage.getItem('agent-desk-pending-create-intents'), null)

  store.setState({ route: { view: 'home' }, draft })
  const newIntent = store.startThread('same prompt', [])
  assert.equal(createRequests().length, 3)
  const newRequest = createRequests()[2]
  assert.notEqual(newRequest.createId, firstRequest.createId)
  assert.equal(await newIntent, true)
  assert.equal(createRequests().length, 3)
})
