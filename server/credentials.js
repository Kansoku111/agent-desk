// Reads and edits the DeepSeek Harness credential store
// ($DSH_HOME/.credentials.yaml). The running dsh runtime watches this file and
// reloads it, so a key saved here is used by the next model request.
//
// Writes take the same `<file>.lock` writer lock dsh uses, keep comments and
// untouched entries intact, and replace the file atomically with owner-only
// permissions.
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { writeText } from './json-file.js'

// Legacy grant retained ONLY to detect users who need official sign-in again.
export const CODEX_RECORD = 'llm-pi-ai/openai-codex'
export const SIWC_RECORD = 'agent-desk/chatgpt-siwc'
export const SIWC_REGISTRATION = 'agent-desk/chatgpt-registration'
export const SIWC_HOST = 'agent-desk/chatgpt-host'
export const ANTHROPIC_REF = 'ANTHROPIC_API_KEY'
// Reads the organization's usage and cost (Admin API); dsh never uses it.
export const ANTHROPIC_ADMIN_REF = 'ANTHROPIC_ADMIN_KEY'
export const DEEPSEEK_REF = 'DEEPSEEK_API_KEY'
// The name pi-ai's own opencode-go provider reads from the environment.
export const OPENCODE_GO_REF = 'OPENCODE_API_KEY'
// Only for a local server that asks for a key (server/local-llm.js).
export const LOCAL_LLM_REF = 'LOCAL_LLM_API_KEY'

const REF_NAME = /^[A-Z_][A-Z0-9_]*$/

export class CredentialStore {
  constructor(file) {
    this.file = file
  }

  async #readText() {
    try {
      return await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  /** Parsed snapshot: `{ refs, records }`; never throws on a missing file. */
  async read() {
    const text = await this.#readText()
    if (text === null || !text.trim()) return { refs: {}, records: {} }
    const doc = YAML.parseDocument(text)
    if (doc.errors.length) throw new Error(`credential file is not valid YAML (${doc.errors[0].code})`)
    const value = doc.toJS() ?? {}
    return { refs: value.refs ?? {}, records: value.records ?? {} }
  }

  async #modify(mutate) {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await withFileLock(this.file, async () => {
      const text = await this.#readText()
      const doc = text?.trim() ? YAML.parseDocument(text) : new YAML.Document({})
      if (doc.errors.length) {
        // Never overwrite content we could not read: the user may fix it by hand.
        throw new Error(`credential file is not valid YAML (${doc.errors[0].code}); not overwriting it`)
      }
      if (!YAML.isMap(doc.contents)) throw new Error('credential file root is not a mapping; not overwriting it')
      mutate(doc)
      for (const section of ['refs', 'records']) {
        const node = doc.get(section)
        if (YAML.isMap(node) && node.items.length === 0) doc.delete(section)
      }
      doc.set('version', 1)
      // Keep `version` first, as dsh renders it.
      const items = doc.contents.items
      const index = items.findIndex((pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key) === 'version')
      if (index > 0) items.unshift(...items.splice(index, 1))
      await writeText(this.file, doc.toString({ lineWidth: 0 }), 0o600)
    }, { waitMs: 15_000 })
  }

  async setRef(name, value) {
    if (!REF_NAME.test(name)) throw new Error(`invalid credential name: ${name}`)
    if (typeof value !== 'string' || value.trim() === '') throw new Error('an empty key cannot be saved')
    await this.#modify((doc) => doc.setIn(['refs', name], value.trim()))
  }

  async unsetRef(name) {
    await this.#modify((doc) => {
      if (doc.hasIn(['refs', name])) doc.deleteIn(['refs', name])
    })
  }

  /** Stores a pi-ai OAuth credential verbatim as a `grant` record. */
  async setGrant(key, payload) {
    const image = JSON.parse(JSON.stringify(payload))
    await this.#modify((doc) => doc.setIn(['records', key], doc.createNode({ kind: 'grant', payload: image })))
  }

  async deleteRecord(key) {
    await this.#modify((doc) => {
      if (doc.hasIn(['records', key])) doc.deleteIn(['records', key])
    })
  }
}

/** Decodes a JWT payload without verifying it (display purposes only). */
export function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** UI-safe summary of the ChatGPT sign-in; never includes a token. */
export function describeChatGpt(records) {
  const payload = records?.[SIWC_RECORD]?.payload
  return {
    signedIn: Boolean(payload?.access_token && payload?.subject),
    email: payload?.email ?? null,
    plan: null,
    official: true,
    planEnabled: Boolean(payload?.scopes?.includes('chatgpt.tokens.use.direct')),
    expiresAt: payload?.expires_at ? Date.parse(payload.expires_at) : null,
    needsOfficialLogin: !payload?.access_token && Boolean(records?.[CODEX_RECORD]?.payload?.access),
  }
}

/** Masks a secret for display: keeps a short prefix and the last 4 characters. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length <= 12) return '••••'
  return `${value.slice(0, 7)}…${value.slice(-4)}`
}
