// How fs-read-hook.js changes dsh-tool-fs, kept apart so tests can check the patch.
//
// read rejects a `limit` above its line cap (2000 by default), but its schema only
// says the cap is the default. A program then asked for 10000 lines to read whole CSV
// files, the read failed, and the model rewrote the whole 9,000-character program
// (Agent Desk lab, sales task, Luna max, 2026-11-15). Say the cap where the model reads
// the argument; validation and the cap itself stay upstream's.
const LIMIT = 'description: `Maximum number of lines to return. Defaults to ${caps.limit}.`'
const STATED = 'description: `Maximum number of lines to return. Defaults to ${caps.limit}, which is also the largest value accepted; continue a longer file with offset.`'

export function patchFsReadSource(source) {
  if (source.split(LIMIT).length !== 2) return null
  return source.replace(LIMIT, () => STATED)
}
