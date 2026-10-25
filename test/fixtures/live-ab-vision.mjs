// Explicit opt-in, billable vision smoke check; never runs under npm test.
// node test/fixtures/live-ab-vision.mjs --run
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { EventEmitter, once } from 'node:events'
import assert from 'node:assert/strict'
import { ClaudeRunner } from '../../server/claude-runner.js'
import { AbRunner } from '../../server/ab-runner.js'
if (!process.argv.includes('--run')) throw new Error('Pass --run to make one live Claude Code vision request using its current authentication')
// A generated 64x64 solid-color PNG: the prompt deliberately does not name the color.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const label = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])))
  return Buffer.concat([length, label, data, crc])
}
const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
const pixels = Buffer.alloc(64 * (1 + 64 * 3))
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-live-vision-'))
const agents = await new ClaudeRunner({ dir: path.join(dir, 'agents') }).load()
let timer
try {
  const file = `${randomUUID()}.png`; await fs.writeFile(path.join(dir, file), png)
  const runner = new AbRunner({ threads: new EventEmitter(), agents, attachmentsDir: dir })
  const result = once(runner, 'finished')
  const handle = await runner.start({ runId: 'vision', jobId: 'vision', workspace: dir, model: 'claude:haiku', images: [{ file, mimeType: 'image/png', name: 'sample.png' }], text: 'What color fills the attached image? Reply with one English color word. Do not use tools.', instructions: 'This is a vision transport smoke check only. Do not read or change any files. Do not use tools.', writable: false, lean: true })
  timer = setTimeout(() => agents.stop(handle.id), 90000)
  const [event] = await result
  console.log(JSON.stringify({ status: event.status, text: event.text, error: event.error ?? null }))
  assert.equal(event.status, 'completed')
  assert.match(event.text, /^red[.!\s]*$/i)
  console.log('PASS: installed Claude Code recognized the image sent through AB stream-json')
} finally {
  clearTimeout(timer); await agents.shutdown()
  const resolved = path.resolve(dir)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ab-live-vision-')) throw new Error('Unexpected temporary cleanup target')
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5 })
}
