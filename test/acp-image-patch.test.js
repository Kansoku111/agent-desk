import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCompatibilityModules } from '../server/dsh-compatibility.js'
import '../server/acp-image-hook.js'

// Expose the private decoder from the actual ACP module without starting dsh or calling a model.
const acp = `${pathToFileURL(resolveCompatibilityModules(fileURLToPath(new URL('../', import.meta.url))).acp).href}?image-test`
const observer = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    return url === acp ? { ...result, source: `${result.source}\nexport { decodeImage };` } : result
  },
})
const { decodeImage } = await import(acp).finally(() => observer.deregister())

const png = (data) => ({ mimeType: 'image/png', data })

test('ACP decodes a multi-megabyte inline image without changing the bytes', () => {
  // Only the base64 decoder is under test; raster validation happens later.
  const bytes = Buffer.alloc(5 * 1024 * 1024, 'Agent Desk\0\xff', 'latin1')
  const decoded = decodeImage(png(bytes.toString('base64')))
  assert.equal(decoded.mediaType, 'image/png')
  assert.ok(decoded.data.equals(bytes))
})

test('ACP still rejects aliases of canonical image base64', () => {
  assert.deepEqual(decodeImage(png('/w==')).data, Buffer.from([255]))
  for (const data of ['_w==', '/x==', '/w', '/w===', '/ w==', '/w==\n']) {
    assert.throws(() => decodeImage(png(data)), { name: 'AcpContentError', kind: 'invalid', message: 'image data must be canonical base64' })
  }
})
