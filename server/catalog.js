// The model catalog the composer shows before a thread has a live session.
// It is learned from ACP session config options and cached on disk.
import { debouncedWriter, readJson } from './json-file.js'
import { parseConfigOptions } from './transcript.js'

export const PROVIDER_LABELS = {
  'openai-codex': 'ChatGPT',
  anthropic: 'Claude',
  'deepseek-official': 'DeepSeek',
  'opencode-go': 'OpenCode Go',
  openscale: 'OpenScale',
  'command-code': 'Command Code',
  'command-code-claude': 'Command Code（Claude）',
  'local-llm': 'ローカル LLM',
}

const FALLBACK_EFFORTS = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
]

/** Does the picker contain exactly the Command Code inventory served by this runtime? */
export function matchesCommandCodeCatalog(expected, models) {
  const wanted = expected
    .filter((entry) => Array.isArray(entry) && entry.length === 3)
    .map(([endpoint, id, name]) => JSON.stringify([endpoint === 'messages' ? 'command-code-claude' : 'command-code', id, name])).sort()
  const actual = models.filter((model) => ['command-code', 'command-code-claude'].includes(model.provider))
    .map((model) => JSON.stringify([model.provider, model.id, model.name])).sort()
  return JSON.stringify(actual) === JSON.stringify(wanted)
}

// A runtime can finish learning options it fetched before the catalog signature
// changed (for example, while a DeepSeek or OpenCode Go key is being saved). Such a snapshot
// must not make that new signature look current.
function matchesSignature(signature, models) {
  let requirements
  try {
    requirements = JSON.parse(signature)
  } catch {
    return true
  }
  if (!requirements || typeof requirements !== 'object') return true
  const matches = (name, provider) => typeof requirements[name] !== 'boolean'
    || models.some((model) => model.provider === provider) === requirements[name]
  if (!matches('deepseek', 'deepseek-official') || !matches('opencodeGo', 'opencode-go') || !matches('openscale', 'openscale')) return false
  if (Array.isArray(requirements.opencodeGoModels)) {
    const actual = models.filter((model) => model.provider === 'opencode-go').map((model) => model.id).sort()
    // parseConfigOptions omits dated aliases from the UI catalog.
    const expected = [...new Set(requirements.opencodeGoModels)].filter((id) => !/-\d{8}$/.test(id)).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false
  }
  if (Array.isArray(requirements.commandCode) && !matchesCommandCodeCatalog(requirements.commandCode, models)) return false
  // An old runtime can finish after a local server switch. Compare IDs before
  // accepting its snapshot, including when the saved signature was corrupted.
  if (requirements.local && Array.isArray(requirements.local.models)) {
    const expected = [...new Set(requirements.local.models.map((model) => model.id))].filter((id) => typeof id === 'string' && !/-\d{8}$/.test(id)).sort()
    const actual = models.filter((model) => model.provider === 'local-llm').map((model) => model.id).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false
  }
  return true
}

export class Catalog {
  /**
   * @param file - the cache file.
   * @param signature - what the served catalog depends on (dsh version and
   *   the models Agent Desk adds); a cache learned under another one is stale.
   */
  constructor(file, signature = null) {
    this.file = file
    this.writer = debouncedWriter(file, 10)
    this.signature = signature
    this.data = { models: [], effortsByModel: {}, updatedAt: null, signature: null }
  }

  async load() {
    this.data = await readJson(this.file, this.data)
    this.data.models ??= []
    this.data.effortsByModel ??= {}
    return this
  }

  get empty() {
    return this.data.models.length === 0
  }

  get stale() {
    return this.empty || this.data.signature !== this.signature || !matchesSignature(this.signature, this.data.models)
  }

  /** Marks the cache stale after the served catalog changed. */
  setSignature(signature) {
    this.signature = signature
  }

  /** Learns from one config-options snapshot; returns true when something changed. */
  learn(configOptions) {
    const parsed = parseConfigOptions(configOptions)
    let changed = false
    const models = parsed.models.filter((model) => PROVIDER_LABELS[model.provider])
    const current = models.length > 0 && matchesSignature(this.signature, models)
    // A pending restart can leave old sessions emitting config options. They
    // must neither replace an existing list nor mark the new signature current.
    if (!current && this.data.models.length) return false
    // Preserve choices across unrelated catalog changes. A new runtime version,
    // capability revision or route still requires fresh ACP discovery.
    if (current && this.data.signature !== this.signature) {
      const reusable = reusableCommandCodeModels(this.data.signature, this.signature)
      for (const model of models.filter((entry) => ['command-code', 'command-code-claude'].includes(entry.provider))) {
        if (reusable.has(model.value)) continue
        this.data.effortsByModel[model.value] = []
        changed = true
      }
    }
    if (models.length && JSON.stringify(models) !== JSON.stringify(this.data.models)) {
      this.data.models = models
      changed = true
    }
    if (current && this.data.signature !== this.signature) {
      this.data.signature = this.signature
      changed = true
    }
    if (parsed.currentModel && configOptions.some((option) => option.id === 'model')) {
      const before = JSON.stringify(this.data.effortsByModel[parsed.currentModel] ?? null)
      if (before !== JSON.stringify(parsed.efforts)) {
        this.data.effortsByModel[parsed.currentModel] = parsed.efforts
        changed = true
      }
    }
    if (changed) {
      this.data.updatedAt = Date.now()
      this.writer.schedule(this.data)
    }
    return changed
  }

  /** Finish any queued catalog write before the app exits. */
  flush() {
    return this.writer.flush()
  }

  snapshot() {
    return {
      providers: PROVIDER_LABELS,
      models: this.data.models,
      effortsByModel: this.data.effortsByModel,
      fallbackEfforts: FALLBACK_EFFORTS,
    }
  }
}

/** Only an unchanged runtime/capability generation may reuse old ACP choices. */
function reusableCommandCodeModels(previous, current) {
  let before, after
  try { before = JSON.parse(previous); after = JSON.parse(current) } catch { return new Set() }
  if (!before || !after || typeof before.dsh !== 'string' || before.dsh !== after.dsh
    || !Number.isSafeInteger(before.commandCodeLearn) || before.commandCodeLearn !== after.commandCodeLearn
    || !Array.isArray(before.commandCode) || !Array.isArray(after.commandCode)) return new Set()
  return new Set(before.commandCode.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length !== 3 || !['chat', 'messages'].includes(entry[0])
      || typeof entry[1] !== 'string' || !entry[1]) return []
    return [JSON.stringify([entry[0] === 'messages' ? 'command-code-claude' : 'command-code', entry[1]])]
  }))
}
