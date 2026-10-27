// One anonymous, bounded public catalog read shared by model and pricing updates.
export const MODEL_REGISTRY_URL = 'https://models.opencode.ai/api.json'
const MAX_BYTES = 16 * 1024 * 1024
const MAX_AGE_MS = 6 * 60 * 60 * 1000

export async function readModelRegistry(fetchImpl = fetch) {
  const response = await fetchImpl(MODEL_REGISTRY_URL, { redirect: 'error', signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error('Model registry HTTP ' + response.status)
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Model registry is too large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Model registry has no body')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('Model registry is too large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Concurrent consumers share a single download and a short-lived in-memory snapshot. */
export class ModelRegistry {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl
    this.now = now
    this.body = null
    this.checkedAt = null
    this.pending = null
  }

  get({ force = false } = {}) {
    if (this.pending) return this.pending
    if (!force && this.body && this.now() - this.checkedAt < MAX_AGE_MS) return Promise.resolve(this.body)
    const work = readModelRegistry(this.fetchImpl).then((body) => {
      this.body = body
      this.checkedAt = this.now()
      return body
    })
    this.pending = work
    void work.finally(() => { if (this.pending === work) this.pending = null }).catch(() => {})
    return work
  }
}
