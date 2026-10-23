// Small helpers for JSON documents owned by Agent Desk: atomic replace on
// write and a forgiving read that falls back to a default.
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export async function readJson(file, fallback, { recoverCorrupt = true } = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback)
    if (recoverCorrupt && error instanceof SyntaxError) {
      // Keep the broken file for inspection instead of silently discarding it.
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      return structuredClone(fallback)
    }
    throw error
  }
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`

async function writeText(file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, text, { mode })
}

export async function writeJson(file, value, mode = 0o600) {
  await writeText(file, serialize(value), mode)
}

/**
 * Coalesces bursts of writes to one file: the latest value wins, and at most
 * one write is in flight at a time.
 */
export function debouncedWriter(file, delayMs = 250) {
  let timer = null
  let pending = undefined
  let chain = Promise.resolve()
  let latest = chain
  const enqueue = (value) => {
    // Snapshot now, not when preceding writes finish: callers may roll back an
    // unsuccessful admission or keep streaming into the same transcript. The
    // text is the snapshot: it is what would be written, without a copy of the value.
    const snapshot = serialize(value)
    latest = chain.then(() => writeText(file, snapshot))
    chain = latest.catch(() => {}) // A failed write must not poison later writes.
    return latest
  }
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending === undefined) return latest
    const value = pending
    pending = undefined
    return enqueue(value)
  }
  return {
    schedule(value) {
      pending = value
      if (!timer) timer = setTimeout(() => {
        void flush().catch((error) => console.error(`[agent-desk] failed to write ${file}:`, error.message))
      }, delayMs)
    },
    flush,
    // Durable admission uses this path: unlike background writes its failure
    // reaches the caller, and no older debounced value can overwrite it later.
    write(value) {
      if (timer) clearTimeout(timer)
      timer = null
      pending = undefined
      return enqueue(value)
    },
  }
}
