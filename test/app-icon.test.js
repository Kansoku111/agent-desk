import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const read = (name) => readFile(new URL(name, root))

test('Windows icon includes the expected PNG sizes and a content-hashed name', async () => {
  const name = 'agent-desk-4ced0141.ico'
  const icon = await read(`assets/${name}`)
  const hash = createHash('sha256').update(icon).digest('hex').slice(0, 8)
  assert.equal(name, `agent-desk-${hash}.ico`)
  assert.equal(icon.readUInt16LE(0), 0)
  assert.equal(icon.readUInt16LE(2), 1)
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  assert.equal(icon.readUInt16LE(4), sizes.length)
  for (const [i, size] of sizes.entries()) {
    const entry = 6 + 16 * i
    assert.equal(icon[entry] || 256, size)
    assert.equal(icon[entry + 1] || 256, size)
    const length = icon.readUInt32LE(entry + 8)
    const offset = icon.readUInt32LE(entry + 12)
    const frame = icon.subarray(offset, offset + length)
    assert.equal(frame.length, length)
    assert.equal(frame.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(frame.readUInt32BE(16), size)
    assert.equal(frame.readUInt32BE(20), size)
  }
})

test('Windows shortcut generator and updater use the current icon', async () => {
  const script = await read('scripts/install-shortcut.ps1').then(String)
  const updater = await read('scripts/updater/build-updater.ps1').then(String)
  assert.match(script, /assets\\agent-desk-icon\.png/)
  assert.match(updater, /assets\\agent-desk-4ced0141\.ico/)
  const image = await read('assets/agent-desk-icon.png')
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(image.readUInt32BE(16), 512)
  assert.equal(image.readUInt32BE(20), 512)
})
