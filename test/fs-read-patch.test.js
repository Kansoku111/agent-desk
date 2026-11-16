import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import { patchFsReadSource } from '../server/fs-read-patch.js'
import '../server/fs-read-hook.js'

const require = createRequire(import.meta.url)
const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-fs'), 'utf8')

test('read states its line cap in the limit description, and only there', () => {
  const patched = patchFsReadSource(source)
  assert.ok(patched)
  assert.match(patched, /Defaults to \$\{caps\.limit\}, which is also the largest value accepted; continue a longer file with offset\./)
  // Validation is upstream's and unchanged.
  assert.ok(patched.includes('if (limit > maxLimit) throw new ToolArgsError([`limit must be less than or equal to ${maxLimit}`]);'))
  assert.equal(patchFsReadSource(patched), null)
  assert.equal(patchFsReadSource('export {}'), null)
})

test('the loaded dsh-tool-fs declares the cap through the real load hook', async () => {
  // Dynamic import goes through the registered load hook without touching node_modules.
  const fsTool = await import('@deepseek-ai/dsh-tool-fs')
  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool), get: (name) => tools.get(name) },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
  }
  fsTool.apply(ctx, { read: true, readImage: false, write: false, edit: false, applyPatch: false, readLimit: 1500, readMaxLineLength: 2000, readMaxBytes: 65536, readStreamMinSize: 1 << 20 })
  assert.match(JSON.stringify(tools.get('read')), /Defaults to 1500, which is also the largest value accepted; continue a longer file with offset\./)
  assert.ok(!source.includes('largest value accepted'))
})
