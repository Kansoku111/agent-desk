// Small helpers for JSON documents owned by Agent Desk: atomic replace on
// write and a forgiving read that falls back to a default.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Corrupt files that could not be moved aside. Writing them again would replace
// the only copy, so this process refuses to write them.
const unmovable = new Set()

/** A corrupt file that could not be moved aside; its content is still on disk. */
export class UnmovableFileError extends Error {}

export async function readJson(file, fallback, { recoverCorrupt = true } = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback)
    if (recoverCorrupt && error instanceof SyntaxError) {
      // Keep the broken file for inspection instead of silently discarding it.
      // Without a kept copy the fallback must not be used: a later save would replace the file.
      const key = path.resolve(file)
      try {
        await fs.rename(file, `${file}.corrupt-${Date.now()}`)
      } catch (renameError) {
        unmovable.add(key)
        throw new UnmovableFileError(`${file} is not valid JSON and could not be moved aside: ${renameError.message}`, { cause: error })
      }
      unmovable.delete(key)
      return structuredClone(fallback)
    }
    throw error
  }
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`

// Windows can hold a file for a moment after another process touched it, so
// a replace that fails with these errors is retried a few times.
const REPLACE_RETRY_MS = [20, 40, 80, 160, 200, 200, 200, 200]

async function replaceFile(from, to) {
  for (let retry = 0; ; retry += 1) {
    try {
      return await fs.rename(from, to)
    } catch (error) {
      const transient = process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code)
      if (!transient || retry >= REPLACE_RETRY_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, REPLACE_RETRY_MS[retry]))
    }
  }
}

/**
 * Replaces `file` only once the new text is on disk: the temp file is synced
 * before the rename, so a crash leaves the old file or the new one, not an
 * empty file under the old name.
 */
export async function writeText(file, text, mode = 0o600) {
  if (unmovable.has(path.resolve(file))) throw new Error(`${file} could not be read and was not moved aside; not overwriting it`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await fs.open(temp, 'wx', mode)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await replaceFile(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeJson(file, value, mode = 0o600) {
  await writeText(file, serialize(value), mode)
}

const RETRY_MAX_MS = 5_000

/**
 * Coalesces bursts of writes to one file: the latest value wins, and at most
 * one write is in flight at a time. A background write that fails keeps its
 * value and is retried with a growing delay, unless a newer value replaces it.
 */
export function debouncedWriter(file, delayMs = 250) {
  let timer = null
  let pending = undefined
  let chain = Promise.resolve()
  let latest = chain
  let queued = 0
  let failures = 0
  const enqueue = (value) => {
    // Snapshot now, not when preceding writes finish: callers may roll back an
    // unsuccessful admission or keep streaming into the same transcript. The
    // text is the snapshot: it is what would be written, without a copy of the value.
    const snapshot = serialize(value)
    queued += 1
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
  const background = () => {
    timer = null
    const value = pending
    pending = undefined
    if (value === undefined) return
    const write = enqueue(value)
    const id = queued
    write.then(() => { failures = 0 }, (error) => {
      console.error(`[agent-desk] failed to write ${file}:`, error.message)
      // Nobody awaits a background write, so the value stays queued for a retry.
      // A value queued after this one already supersedes it.
      if (id !== queued) return
      if (pending === undefined) pending = value
      if (!timer) {
        failures += 1
        timer = setTimeout(background, Math.min(delayMs * 2 ** failures, RETRY_MAX_MS))
        timer.unref()
      }
    })
  }
  return {
    schedule(value) {
      pending = value
      if (!timer) timer = setTimeout(background, delayMs)
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
