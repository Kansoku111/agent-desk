import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCompatibilityModules } from '../server/dsh-compatibility.js'
import '../server/mcp-image-hook.js'

const { mcpClient } = resolveCompatibilityModules(fileURLToPath(new URL('../', import.meta.url)))
const { createMcpToolDefinition } = await import(pathToFileURL(mcpClient))

async function project(data, saveImages) {
  const services = {
    attachments: { saveImages },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
  }
  const tool = createMcpToolDefinition({ get: (key) => services[key] }, {
    name: 'fixture', rawName: 'fixture', inputSchema: { type: 'object' },
    call: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data }] }),
  })
  const exec = { agent: { options: { provider: 'fixture', model: 'vision' }, session: { requestHeader: () => undefined } }, signal: new AbortController().signal }
  const value = await tool.execute({}, exec)
  return tool.projectContent(exec, { value, content: tool.output.render({}, value) })
}

test('dsh projects a multi-megabyte MCP image as an image rather than a stack error', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 'Agent Desk\0\xff', 'latin1')
  const attachment = { id: 'fixture-attachment' }
  let saved
  const content = await project(bytes.toString('base64'), async (images) => {
    saved = images
    return [attachment]
  })
  assert.deepEqual(content, [{ type: 'image', attachment }])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.ok(saved[0].data.equals(bytes))
})

test('dsh still refuses noncanonical MCP image data before storage', async () => {
  let saved = false
  const content = await project('/x==', async () => { saved = true })
  assert.equal(saved, false)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /not canonical base64/)
})
