import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { debouncedWriter, readJson } from '../server/json-file.js'

async function temporary(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-thread-storage-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  return base
}

test('durable writes snapshot their input and replace older scheduled values', async (t) => {
  const base = await temporary(t)
  const file = path.join(base, 'turns.json')
  const writer = debouncedWriter(file)
  writer.schedule({ receipt: 'obsolete' })
  const value = { receipt: { status: 'accepted' } }
  const writing = writer.write(value)
  value.receipt.status = 'mutated while writing'
  await writing
  await writer.flush()
  assert.deepEqual(await readJson(file), { receipt: { status: 'accepted' } })
  writer.schedule({ receipt: 'latest' })
  await writer.flush()
  assert.deepEqual(await readJson(file), { receipt: 'latest' })
})

test('durable writes and flush report failures without poisoning subsequent writes', async (t) => {
  const base = await temporary(t)
  const blocker = path.join(base, 'blocked')
  await fs.writeFile(blocker, 'not a directory')
  const file = path.join(blocker, 'turns.json')
  const writer = debouncedWriter(file)
  await assert.rejects(writer.write({ receipt: 'not accepted' }), /EEXIST|ENOTDIR/)
  await assert.rejects(writer.flush(), /EEXIST|ENOTDIR/)
  await fs.rm(blocker)
  await writer.write({ receipt: 'accepted' })
  await writer.flush()
  assert.deepEqual(await readJson(file), { receipt: 'accepted' })
})

test('concurrent durable writes keep invocation order and remain independent of mutations', async (t) => {
  const base = await temporary(t)
  const file = path.join(base, 'turns.json')
  const writer = debouncedWriter(file)
  const first = { receipts: ['one'] }
  const second = { receipts: ['one', 'two'] }
  const writes = [writer.write(first), writer.write(second)]
  first.receipts.push('late-first')
  second.receipts.push('late-second')
  await Promise.all(writes)
  assert.deepEqual(await readJson(file), { receipts: ['one', 'two'] })
})

test('strict receipt reads do not rename corruption into an apparently missing file', async (t) => {
  const base = await temporary(t)
  const file = path.join(base, 'turns.json')
  await fs.writeFile(file, '{broken')
  await assert.rejects(readJson(file, { turns: [] }, { recoverCorrupt: false }), SyntaxError)
  await assert.rejects(readJson(file, { turns: [] }, { recoverCorrupt: false }), SyntaxError)
  assert.equal(await fs.readFile(file, 'utf8'), '{broken')
  assert.deepEqual(await readJson(path.join(base, 'missing.json'), { turns: [] }, { recoverCorrupt: false }), { turns: [] })
})
