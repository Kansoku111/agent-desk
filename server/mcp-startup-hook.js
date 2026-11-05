import { registerHooks } from 'node:module'
import { patchMcpStartupSource } from './mcp-startup-patch.js'

const TARGET = /\/@deepseek-ai\/dsh-acp\/lib\/index\.js$/
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:') || !TARGET.test(new URL(url).pathname) || result.source == null) return result
    const patched = patchMcpStartupSource(String(result.source))
    if (!patched) {
      process.stderr.write('[agent-desk] MCP startup: runtime did not match; using sequential connections\n')
      return result
    }
    return { ...result, source: patched }
  },
})
