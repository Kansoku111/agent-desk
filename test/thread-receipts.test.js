import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { debouncedWriter } from '../server/json-file.js'
import { deferred, fixture, pending } from './helpers/thread-manager.js'

test('same-ID concurrent sends acknowledge the durable turn once, including across APIs', async (t) => {
  const f = await fixture(t)
  const message = { text: 'hello', messageId: randomUUID() }
  const [first, duplicate] = await Promise.all([
    f.manager.send(f.thread.id, message), f.manager.send(f.thread.id, message),
  ])
  assert.deepEqual(first, duplicate)
  assert.deepEqual(first, { status: 'accepted', turnId: first.turnId, kind: 'send' })
  const document = await f.disk()
  assert.equal(document.turns.length, 1)
  assert.equal(document.turns[0].user.messageId, message.messageId)
  assert.equal(document.receipts[0].status, 'accepted')
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), first)
  assert.deepEqual(await f.manager.steer(f.thread.id, message), { ...first, steered: true })
  await f.started.promise
  assert.equal(f.calls.prompts.length, 1)
  assert.equal(f.calls.steers.length, 0)
})

test('neither model execution nor ack/status precedes durable send admission', async (t) => {
  const f = await fixture(t)
  const writing = deferred()
  const release = deferred()
  const writer = debouncedWriter(f.turnFile)
  f.manager.turnWriters.set(f.thread.id, {
    ...writer,
    async write(value) { writing.resolve(); await release.promise; return writer.write(value) },
  })
  const message = { text: 'hello', messageId: randomUUID() }
  const sending = f.manager.send(f.thread.id, message)
  await writing.promise
  const status = f.manager.messageStatus(f.thread.id, message.messageId)
  await pending(sending)
  await pending(status)
  assert.equal(f.calls.sessions, 0)
  assert.equal(f.calls.prompts.length, 0)
  release.resolve()
  const result = await sending
  assert.deepEqual(await status, result)
  assert.equal((await f.disk()).receipts[0].messageId, message.messageId)
})

test('removal during send persistence waits for admission then cancels without starting a session', async (t) => {
  const f = await fixture(t)
  const writing = deferred()
  const release = deferred()
  const writer = debouncedWriter(f.turnFile)
  f.manager.turnWriters.set(f.thread.id, {
    ...writer,
    async write(value) { writing.resolve(); await release.promise; return writer.write(value) },
  })
  const sending = f.manager.send(f.thread.id, { text: 'hello', messageId: randomUUID() })
  await writing.promise
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  release.resolve()
  assert.equal((await sending).status, 'accepted')
  await removal
  assert.equal(f.calls.sessions, 0)
  assert.equal(f.calls.prompts.length, 0)
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
})

test('send checks its receipt on disk before invoking even a synchronous model', async (t) => {
  const f = await fixture(t)
  const message = { text: 'hello', messageId: randomUUID() }
  const observed = deferred()
  f.runtime.prompt = async () => {
    const document = await f.disk()
    assert.equal(document.receipts[0].messageId, message.messageId)
    assert.equal(document.receipts[0].status, 'accepted')
    assert.equal(document.turns[0].user.messageId, message.messageId)
    observed.resolve()
    return { stopReason: 'end_turn' }
  }
  await f.manager.send(f.thread.id, message)
  await observed.promise
})

test('accepted send survives restart and rejects changed payloads', async (t) => {
  const f = await fixture(t)
  const message = { text: 'hello', messageId: randomUUID(), images: [{ file: `${randomUUID()}/note.txt`, name: 'note.txt' }] }
  const first = await f.manager.send(f.thread.id, message)
  await f.started.promise
  await assert.rejects(f.manager.send(f.thread.id, { ...message, text: 'different' }), /異なるメッセージ/)
  await assert.rejects(f.manager.steer(f.thread.id, { ...message, images: [] }), /異なるメッセージ/)
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  assert.deepEqual(await restarted.messageStatus(f.thread.id, message.messageId), first)
  assert.deepEqual(await restarted.send(f.thread.id, message), first)
  assert.deepEqual(await restarted.steer(f.thread.id, message), { ...first, steered: true })
  await assert.rejects(restarted.send(f.thread.id, { ...message, text: 'changed after restart' }), /異なるメッセージ/)
  assert.equal(f.calls.prompts.length, 1)
})

test('a failed send write is not accepted and does not execute; the same ID can retry', async (t) => {
  const f = await fixture(t)
  // An ordinary file where the transcript directory belongs causes a real
  // filesystem error, without touching application data or runtime sessions.
  await fs.writeFile(f.paths.threadsDir, 'not a directory')
  const message = { text: 'hello', messageId: randomUUID() }
  await assert.rejects(f.manager.send(f.thread.id, message), /EEXIST|ENOTDIR/)
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), { status: 'missing' })
  assert.equal(f.calls.sessions, 0)
  assert.equal(f.calls.prompts.length, 0)
  assert.equal(f.manager.busy, false)
  assert.equal((await f.manager.get(f.thread.id)).turns.length, 0)
  await fs.rm(f.paths.threadsDir)
  const result = await f.manager.send(f.thread.id, message)
  assert.equal(result.status, 'accepted')
  assert.equal((await f.disk()).turns.length, 1)
})

test('a failed index write also prevents model execution and accepted receipt', async (t) => {
  const f = await fixture(t)
  const flush = f.manager.indexWriter.flush
  let fail = true
  t.mock.method(f.manager.indexWriter, 'flush', async () => {
    if (fail) { fail = false; throw new Error('index write failed') }
    return flush()
  })
  const message = { text: 'hello', messageId: randomUUID() }
  await assert.rejects(f.manager.send(f.thread.id, message), /index write failed/)
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), { status: 'missing' })
  assert.equal(f.calls.sessions, 0)
  assert.equal((await f.manager.send(f.thread.id, message)).status, 'accepted')
})

test('steer writes pending before runtime acceptance and accepted before acknowledgement', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const message = { text: 'follow up', messageId: randomUUID() }
  const steering = deferred()
  const release = deferred()
  f.runtime.steer = async () => {
    f.calls.steers.push(message)
    const receipt = (await f.disk()).receipts.find((entry) => entry.messageId === message.messageId)
    assert.equal(receipt.status, 'pending')
    steering.resolve()
    await release.promise
    return true
  }
  const first = f.manager.steer(f.thread.id, message)
  await steering.promise
  const duplicate = f.manager.steer(f.thread.id, message)
  const viaSend = f.manager.send(f.thread.id, message)
  await pending(first)
  release.resolve()
  const accepted = await first
  assert.deepEqual(accepted, { status: 'accepted', turnId: accepted.turnId, kind: 'steer', steered: true })
  assert.deepEqual(await duplicate, accepted)
  assert.deepEqual(await viaSend, { status: 'accepted', turnId: accepted.turnId, kind: 'steer' })
  const doc = await f.disk()
  assert.equal(doc.receipts[0].status, 'accepted')
  assert.equal(doc.turns[0].items.find((item) => item.type === 'steer').messageId, message.messageId)
  assert.equal(f.calls.steers.length, 1)
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  assert.deepEqual(await restarted.steer(f.thread.id, message), accepted)
  assert.equal(f.calls.steers.length, 1)
})

test('a definitely unaccepted steer permits fallback to send with the same ID', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const message = { text: 'follow up', messageId: randomUUID() }
  f.runtime.steer = async () => false
  assert.deepEqual(await f.manager.steer(f.thread.id, message), { steered: false })
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), { status: 'missing' })
  assert.deepEqual((await f.disk()).receipts, [])
  const done = f.manager.active.get(f.thread.id).done
  f.finish.resolve()
  await done
  const result = await f.manager.send(f.thread.id, message)
  assert.equal(result.kind, 'send')
  assert.equal((await f.manager.get(f.thread.id)).turns.length, 2)
})

test('failure to durably clear an unaccepted steer is conservatively uncertain', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  f.runtime.steer = async () => false
  const writer = f.manager.turnWriters.get(f.thread.id)
  const write = writer.write
  let writes = 0
  t.mock.method(writer, 'write', async (value) => {
    if (++writes === 2) throw new Error('clear receipt failed')
    return write(value)
  })
  const message = { text: 'follow up', messageId: randomUUID() }
  assert.deepEqual(await f.manager.steer(f.thread.id, message), { status: 'uncertain' })
  assert.deepEqual(await f.manager.send(f.thread.id, message), { status: 'uncertain' })
  assert.equal((await f.disk()).receipts[0].status, 'pending')
})

test('unknown steering result stays uncertain across retries, APIs and restart', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const message = { text: 'follow up', messageId: randomUUID() }
  f.runtime.steer = async () => { f.calls.steers.push(message); throw new Error('connection lost after delivery') }
  assert.deepEqual(await f.manager.steer(f.thread.id, message), { status: 'uncertain' })
  assert.equal((await f.disk()).receipts[0].status, 'pending')
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), { status: 'uncertain' })
  assert.deepEqual(await f.manager.send(f.thread.id, message), { status: 'uncertain' })
  assert.deepEqual(await f.manager.steer(f.thread.id, message), { status: 'uncertain' })
  await assert.rejects(f.manager.send(f.thread.id, { ...message, text: 'different' }), /異なるメッセージ/)
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  assert.deepEqual(await restarted.messageStatus(f.thread.id, message.messageId), { status: 'uncertain' })
  assert.deepEqual(await restarted.send(f.thread.id, message), { status: 'uncertain' })
  assert.deepEqual(await restarted.steer(f.thread.id, message), { status: 'uncertain' })
  assert.equal(f.calls.steers.length, 1)
  assert.equal(f.calls.prompts.length, 1)
})

test('failed pending persistence never sends a steer or reports acceptance', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const writer = f.manager.turnWriters.get(f.thread.id)
  const write = writer.write
  let fail = true
  t.mock.method(writer, 'write', async (value) => {
    if (fail) { fail = false; throw new Error('pending write failed') }
    return write(value)
  })
  const message = { text: 'follow up', messageId: randomUUID() }
  await assert.rejects(f.manager.steer(f.thread.id, message), /pending write failed/)
  assert.equal(f.calls.steers.length, 0)
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), { status: 'missing' })
  assert.equal((await f.manager.steer(f.thread.id, message)).status, 'accepted')
  assert.equal(f.calls.steers.length, 1)
})

test('failed final steering receipt is uncertain, never a replayable rejection', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const writer = f.manager.turnWriters.get(f.thread.id)
  const write = writer.write
  let writes = 0
  t.mock.method(writer, 'write', async (value) => {
    if (++writes === 2) throw new Error('accepted write failed')
    return write(value)
  })
  const message = { text: 'follow up', messageId: randomUUID() }
  assert.deepEqual(await f.manager.steer(f.thread.id, message), { status: 'uncertain', steered: true })
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, message.messageId), { status: 'uncertain' })
  assert.deepEqual(await f.manager.send(f.thread.id, message), { status: 'uncertain' })
  assert.equal(f.calls.steers.length, 1)
  await f.manager.shutdown()
  const restarted = f.makeManager()
  await restarted.load()
  assert.deepEqual(await restarted.messageStatus(f.thread.id, message.messageId), { status: 'uncertain' })
  assert.deepEqual(await restarted.steer(f.thread.id, message), { status: 'uncertain' })
  assert.equal((await f.disk()).receipts[0].status, 'pending')
})

test('a steer the runtime took is reported as delivered even when its record cannot be saved', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const writer = f.manager.turnWriters.get(f.thread.id)
  t.mock.method(writer, 'write', async () => { throw new Error('accepted write failed') })
  // Without a messageId there is no receipt to retry with, so the caller must not send the steer again.
  assert.deepEqual(await f.manager.steer(f.thread.id, { text: 'follow up' }), { status: 'uncertain', steered: true })
  assert.equal(f.calls.steers.length, 1)
})

test('remove waits for in-flight steering receipt completion before deleting the turn file', async (t) => {
  const f = await fixture(t)
  await f.manager.send(f.thread.id, { text: 'initial' })
  await f.started.promise
  const delivering = deferred()
  const release = deferred()
  f.runtime.steer = async () => { delivering.resolve(); await release.promise; return true }
  const steering = f.manager.steer(f.thread.id, { text: 'follow up', messageId: randomUUID() })
  await delivering.promise
  const removal = f.manager.remove(f.thread.id)
  await pending(removal)
  release.resolve()
  assert.equal((await steering).status, 'accepted')
  await removal
  await assert.rejects(fs.access(f.turnFile), { code: 'ENOENT' })
})

test('message IDs are optional UUIDs, case-insensitive and isolated per thread', async (t) => {
  const f = await fixture(t)
  const messageId = randomUUID()
  await assert.rejects(f.manager.send(f.thread.id, { text: 'hello', messageId: 'not-a-uuid' }), /UUID/)
  assert.deepEqual(await f.manager.messageStatus(f.thread.id, messageId), { status: 'missing' })
  const first = await f.manager.send(f.thread.id, { text: 'hello', messageId: messageId.toUpperCase() })
  assert.deepEqual(await f.manager.send(f.thread.id, { text: 'hello', messageId }), first)
  const secondThread = await f.manager.create({ workspace: f.base, model: '["test","model"]' })
  assert.deepEqual(await f.manager.messageStatus(secondThread.id, messageId), { status: 'missing' })
  const second = await f.manager.send(secondThread.id, { text: 'other thread', messageId })
  assert.notEqual(second.turnId, first.turnId)
})

test('corrupt receipts fail closed rather than replaying an accepted message', async (t) => {
  const f = await fixture(t)
  const message = { text: 'hello', messageId: randomUUID() }
  await f.manager.send(f.thread.id, message)
  await f.manager.shutdown()
  await fs.writeFile(f.turnFile, '{broken')
  const prompts = f.calls.prompts.length
  const restarted = f.makeManager()
  await restarted.load()
  await assert.rejects(restarted.messageStatus(f.thread.id, message.messageId), SyntaxError)
  await assert.rejects(restarted.send(f.thread.id, message), SyntaxError)
  assert.equal(f.calls.prompts.length, prompts)
})
