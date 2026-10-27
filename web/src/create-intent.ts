const STORAGE_KEY = 'agent-desk-pending-create-intents'

type Intent = { id: string; fingerprint: string }
type State = { version: 1; intents: Intent[] }
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const completed = new Set<string>()

function createId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function browserStorage(): StorageLike {
  return window.sessionStorage
}

/** A compact equality fingerprint only; the server verifies with SHA-256. */
export function createIntentFingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function readState(storage: StorageLike): State {
  const raw = storage.getItem(STORAGE_KEY)
  if (raw === null) return { version: 1, intents: [] }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('初回送信の再試行情報を読めません。ブラウザーのストレージを確認してください') }
  if (!parsed || typeof parsed !== 'object' || (parsed as State).version !== 1 || !Array.isArray((parsed as State).intents)) {
    throw new Error('初回送信の再試行情報を読めません。ブラウザーのストレージを確認してください')
  }
  const intents = (parsed as State).intents
  if (!intents.every((entry) => entry && typeof entry.id === 'string' && typeof entry.fingerprint === 'string')) {
    throw new Error('初回送信の再試行情報を読めません。ブラウザーのストレージを確認してください')
  }
  return { version: 1, intents }
}

export function beginCreateIntent(
  fingerprint: string,
  storage: StorageLike = browserStorage(),
  newId: () => string = createId,
): Intent {
  const state = readState(storage)
  const pending = state.intents.find((entry) => entry.fingerprint === fingerprint && !completed.has(entry.id))
  if (pending) return pending
  let id = newId()
  while (state.intents.some((entry) => entry.id === id)) id = newId()
  const intent = { id, fingerprint }
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, intents: [...state.intents, intent] }))
  return intent
}

export function completeCreateIntent(id: string, storage: StorageLike = browserStorage()) {
  completed.add(id)
  const state = readState(storage)
  const intents = state.intents.filter((entry) => entry.id !== id)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, intents }))
  } catch (error) {
    if (!intents.length) {
      try { storage.removeItem(STORAGE_KEY); return } catch {}
    }
    throw error
  }
  if (!intents.length) storage.removeItem(STORAGE_KEY)
}
