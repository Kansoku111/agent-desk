import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { Outbox, readQueues } from '../web/src/outbox.ts'
import { RpcClient } from '../web/src/rpc-client.ts'
import { notificationRoute, notificationText } from '../web/src/notification.ts'

async function fixture() {
  const source = await fs.readFile(new URL('../web/src/store.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const exports = {}
  const require = (name) => {
    if (name === 'react') return {}
    if (name === './outbox') return { Outbox, readQueues }
    if (name === './rpc-client') return { RpcClient }
    if (name === './notification') return { notificationRoute, notificationText }
    throw new Error(`unexpected import: ${name}`)
  }
  const storage = { getItem: () => null, setItem() {}, removeItem() {} }
  let socket
  class WebSocket {
    static CLOSING = 2
    readyState = 1
    constructor() { socket = this }
    send() {}
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
  const frame = (value) => socket.onmessage({ data: JSON.stringify(value) })
  frame({ event: 'hello', state: { app: { uiBuild: 'test' }, settings: {}, threads: [], terminals: [], teams: [] } })
  return { store: exports, frame, document, notifications }
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
