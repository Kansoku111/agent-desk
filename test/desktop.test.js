import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { displayFor, parseKeys, toScreen, toView, viewFor } from '../server/desktop.js'
import { startHelper } from '../server/desktop-mcp.js'

const fullHd = { x: 0, y: 0, width: 1920, height: 1080 }
const right4k = { x: 1920, y: 0, width: 3840, height: 2160 }

test('PowerShell helper startup failure rejects readiness', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const current = startHelper(() => child)
  const failure = new Error('PowerShell failed to start')
  const rejected = assert.rejects(current.ready, error => error === failure)
  child.emit('error', failure)
  await rejected
  child.stdin.end()
  child.stdout.end()
  child.stderr.end()
})

test('a PowerShell helper that never reports ready is killed, and the next call starts a new one', async () => {
  const stalled = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => { child.killed = true; return true }
    return child
  }
  const first = stalled()
  const current = startHelper(() => first, 20)
  await assert.rejects(current.ready, /時間内に起動しませんでした/)
  assert.equal(first.killed, true)

  const second = stalled()
  const next = startHelper(() => second, 20)
  assert.notEqual(next, current)
  await assert.rejects(next.ready, /時間内に起動しませんでした/)
  assert.equal(second.killed, true)
})

test('viewFor fits displays into 1280x800 without upscaling', () => {
  assert.deepEqual(viewFor(fullHd), { width: 1280, height: 720 })
  assert.deepEqual(viewFor({ x: 0, y: 0, width: 2560, height: 1600 }), { width: 1280, height: 800 })
  assert.deepEqual(viewFor({ x: 0, y: 0, width: 1024, height: 768 }), { width: 1024, height: 768 })
})

test('toScreen maps screenshot pixels to physical pixels on the right display', () => {
  assert.deepEqual(toScreen(fullHd, 640, 360), { x: 960, y: 540 })
  assert.deepEqual(toScreen(right4k, 0, 0), { x: 1920, y: 0 })
  assert.deepEqual(toScreen(right4k, 1279, 719), { x: 1920 + 3837, y: 2157 })
  assert.throws(() => toScreen(fullHd, 1280, 10), /範囲外/)
  assert.throws(() => toScreen(fullHd, -1, 10), /範囲外/)
})

test('toView is the inverse of toScreen', () => {
  assert.deepEqual(toView(right4k, 1920 + 1920, 1080), { x: 640, y: 360 })
})

test('displayFor picks the display under a window, or the nearest one', () => {
  const displays = [fullHd, right4k]
  assert.equal(displayFor(displays, { x: 2000, y: 100, width: 800, height: 600 }), right4k)
  assert.equal(displayFor(displays, { x: -8, y: -8, width: 1936, height: 1048 }), fullHd)
  assert.equal(displayFor(displays, { x: -5000, y: 0, width: 100, height: 100 }), fullHd)
})

test('parseKeys reads combos, sequences and the plus key', () => {
  assert.deepEqual(parseKeys('ctrl+s'), [[0x11, 0x53]])
  assert.deepEqual(parseKeys('Ctrl+Shift+T'), [[0x11, 0x10, 0x54]])
  assert.deepEqual(parseKeys('ctrl+a ctrl+c'), [[0x11, 0x41], [0x11, 0x43]])
  assert.deepEqual(parseKeys('alt+f4'), [[0x12, 0x73]])
  assert.deepEqual(parseKeys('enter'), [[0x0d]])
  assert.deepEqual(parseKeys('ctrl++'), [[0x11, '+']])
  assert.deepEqual(parseKeys('ctrl+plus'), [[0x11, '+']])
  assert.deepEqual(parseKeys('ctrl+/'), [[0x11, '/']])
  assert.deepEqual(parseKeys('win+1'), [[0x5b, 0x31]])
  assert.throws(() => parseKeys(''), /keys/)
  assert.throws(() => parseKeys('ctrl+banana'), /banana/)
})
