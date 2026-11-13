// Code Mode: an experimental Claude Code 2.1.323+ mode in which Claude writes JavaScript
// that calls its tools. It is switched on by an environment variable, but the first
// start shows a consent screen, and Agent Desk's first message would be typed into it
// (and answer "no"). So the app only starts a task in Code Mode once Claude Code
// has recorded the user's consent itself; it never writes that consent for them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'

/** Claude Code keeps its global state (including the consent flag) beside, not inside, its data folder. */
export function claudeConfigFile(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')
}

let cached = { file: null, mtimeMs: -1, size: -1, value: false }

/** Whether the user already answered "Yes" on Claude Code's Code Mode screen. The file is large and rewritten often, so reads are cached by its stamp. */
export function codeModeConsented(file = claudeConfigFile()) {
  try {
    const stat = fs.statSync(file)
    if (cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.codeModeCaveatsAcceptedV1 === true
    cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, value }
    return value
  } catch {
    return false
  }
}
