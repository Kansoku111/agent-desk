import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { debouncedWriter, writeJson } from '../server/json-file.js'

test('a debounced write holds the value as it was when the write was queued', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-file-'))
  try {
    const file = path.join(dir, 'doc.json')
    const value = { version: 1, turns: [{ id: 'a', items: [{ text: 'before' }] }] }
    const writer = debouncedWriter(file, 5)
    const written = writer.write(value)
    value.turns[0].items[0].text = 'after'
    await written
    const expected = path.join(dir, 'expected.json')
    await writeJson(expected, { version: 1, turns: [{ id: 'a', items: [{ text: 'before' }] }] })
    assert.equal(await fs.readFile(file, 'utf8'), await fs.readFile(expected, 'utf8'))
    assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify({ version: 1, turns: [{ id: 'a', items: [{ text: 'before' }] }] }, null, 2)}\n`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
