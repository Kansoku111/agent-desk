// Loaded into every dsh process with `node --import` (see runtime.js).
//
// Lets an MCP server Agent Desk mounts set its own tool-call timeout (see
// mcp-timeout-patch.js), so image generation is not cut off at dsh's 60
// seconds. If a dsh update changes the source, the module loads unpatched and
// every MCP tool call keeps the 60-second limit (`npm test` fails in
// mcp-timeout-patch.test.js).
import { registerHooks } from 'node:module'
import { patchMcpTimeoutSource } from './mcp-timeout-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchMcpTimeoutSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] mcp timeout hook: dsh-acp did not match; MCP tool calls end after 60 seconds\n')
      return result
    }
    return { ...result, source: patched }
  },
})
