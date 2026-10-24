// Loaded before dsh imports pi-ai. Supply the app-owned, validated additions
// to the JSON catalog in memory; never modify node_modules or execute fetched JS.
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { mergeOpenCodeCatalog } from './opencode-go-catalog.js'

export function isOpenCodeCatalog(url) {
  if (!url.startsWith('file:')) return false
  const parsed = new URL(url)
  return !parsed.search && /\/@earendil-works\/pi-ai\/dist\/providers\/data\/opencode-go\.json$/.test(parsed.pathname)
}

const file = process.env.AGENT_DESK_OPENCODE_CATALOG
if (file) {
  // One immutable snapshot per process, just like the installed catalog.
  let additions = {}
  try {
    additions = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (!isOpenCodeCatalog(url)) return result
      if (result.format !== 'json' || result.source == null) throw new Error('Unsupported OpenCode Go catalog module')
      const original = JSON.parse(typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8'))
      return { ...result, source: JSON.stringify(mergeOpenCodeCatalog(original, additions)) }
    },
  })
}
