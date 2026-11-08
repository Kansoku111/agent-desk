// One task's transcript on disk. The whole document is `<id>.json`; while a
// turn streams, its updates go to `<id>.live.json` with that turn alone.
// Rewriting a long task's whole document for every update (a 47 MB transcript,
// about every 400 ms) blocked the server for ~80 ms each time and wrote tens of
// GB per task. The whole document is still written at every other change, so
// it stays complete except for the streaming turn, and older versions and the
// history search can read it as before.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { readJson, writeText } from './json-file.js'

const RETRY_MAX_MS = 5_000
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`

export const liveFile = (file) => file.replace(/\.json$/, '.live.json')

/**
 * The saved document with its streaming turn put back. The live file names the
 * revision of the whole document it extends; any other one is older than the
 * document and is ignored.
 */
export async function readTranscript(file, fallback) {
  const doc = await readJson(file, fallback, { recoverCorrupt: false })
  const live = await readJson(liveFile(file), null, { recoverCorrupt: false }).catch(() => null)
  if (!doc || typeof doc.revision !== 'string' || live?.revision !== doc.revision || typeof live.turn?.id !== 'string') return doc
  const turns = Array.isArray(doc.turns) ? [...doc.turns] : []
  const index = turns.findIndex((turn) => turn?.id === live.turn.id)
  if (index >= 0) turns[index] = live.turn
  else turns.push(live.turn)
  return { ...doc, turns }
}

/**
 * Like json-file's debouncedWriter for the whole document (`schedule`, `write`,
 * `flush`), plus `scheduleLive(turn, doc)` for updates that change only that
 * turn. `doc` is the whole document, written instead while none has been
 * written yet in this process. `flush` folds a live file back into the document.
 */
export function transcriptWriter(file, delayMs = 400) {
  const live = liveFile(file)
  let timer = null
  let pendingDoc = undefined
  let pendingTurn = undefined
  // The latest whole document given: what a flush writes when only a live file is newer.
  let latestDoc = undefined
  // The revision of the last whole document queued; live files extend it.
  let revision = null
  let liveQueued = false
  let chain = Promise.resolve()
  let latest = chain
  let queued = 0
  let failures = 0

  const append = (task) => {
    queued += 1
    latest = chain.then(task)
    chain = latest.catch(() => {}) // A failed write must not poison later writes.
    return latest
  }
  const enqueueDoc = (doc) => {
    latestDoc = doc
    // Snapshot now, as debouncedWriter does: callers keep changing the turns.
    const next = randomUUID()
    const text = serialize({ ...doc, revision: next })
    revision = next
    liveQueued = false
    return append(async () => {
      await writeText(file, text)
      // The document now holds the streaming turn; a newer live file is queued after this.
      await fs.rm(live, { force: true }).catch(() => {})
    })
  }
  const enqueueTurn = (turn) => {
    const text = serialize({ version: 1, revision, turn })
    liveQueued = true
    return append(() => writeText(live, text))
  }
  const arm = (ms) => {
    if (timer) return
    timer = setTimeout(background, ms)
    timer.unref?.()
  }
  const take = () => {
    const doc = pendingDoc
    const turn = pendingTurn
    pendingDoc = undefined
    pendingTurn = undefined
    if (doc !== undefined) return { write: enqueueDoc(doc), doc }
    if (turn === undefined) return null
    return revision ? { write: enqueueTurn(turn), turn } : { write: enqueueDoc(latestDoc), doc: latestDoc }
  }
  function background() {
    timer = null
    const taken = take()
    if (!taken) return
    const id = queued
    taken.write.then(() => { failures = 0 }, (error) => {
      console.error(`[agent-desk] failed to write ${taken.doc ? file : live}:`, error.message)
      // Nobody awaits a background write, so it stays queued for a retry,
      // unless something queued after it already supersedes it.
      if (id !== queued) return
      if (taken.doc) { if (pendingDoc === undefined) pendingDoc = taken.doc }
      else if (pendingDoc === undefined && pendingTurn === undefined) pendingTurn = taken.turn
      if (!timer) {
        failures += 1
        arm(Math.min(delayMs * 2 ** failures, RETRY_MAX_MS))
      }
    })
  }

  return {
    schedule(doc) {
      latestDoc = doc
      pendingDoc = doc
      // The whole document carries the streaming turn as well.
      pendingTurn = undefined
      arm(delayMs)
    },
    scheduleLive(turn, doc) {
      latestDoc = doc
      if (pendingDoc !== undefined) pendingDoc = doc
      else pendingTurn = turn
      arm(delayMs)
    },
    // Durable admission: its failure reaches the caller, and no older value can overwrite it later.
    write(doc) {
      if (timer) clearTimeout(timer)
      timer = null
      pendingDoc = undefined
      pendingTurn = undefined
      return enqueueDoc(doc)
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      if (pendingDoc !== undefined || ((pendingTurn !== undefined || liveQueued) && latestDoc !== undefined)) {
        const doc = pendingDoc ?? latestDoc
        pendingDoc = undefined
        pendingTurn = undefined
        return enqueueDoc(doc)
      }
      return latest
    },
  }
}
