// Japanese descriptions for skills written in other languages (Settings → Skills).
// The untranslated descriptions of a project are translated in small batches by
// a model the user picks for that run (both at low effort, no tools):
//   haiku — one Claude Code `-p` call per batch
//   luna  — one ephemeral Codex turn per batch (ChatGPT sign-in of Settings → Account)
// Results are cached by description text. It runs only when the user presses the
// button; Claude Code also needs an auth mode the user already confirmed for agent
// teams. These are billed model calls.
import { spawn as spawnProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { claudeAuthEnv } from './claude-auth.js'
import { readJson, writeJson } from './json-file.js'
import { findClaude, launchCommand } from './terminal-helpers.js'

export const ENGINES = ['haiku', 'luna']
const CLAUDE_MODEL = 'haiku'
const CODEX_MODEL = 'gpt-6-luna'
const EFFORT = 'low'
const TIMEOUT_MS = 90_000
const BATCH_MAX = 40
// A batch is one reply the model must keep in order; a small one rarely drifts, and
// a failed one costs only itself because finished batches are already cached.
const CHUNK = 10
const ATTEMPTS = 2
const TEXT_MAX = 600
const JAPANESE = /[぀-ヿ㐀-鿿]/
const SYSTEM = 'You translate software tool descriptions into natural Japanese.'
// Without a schema Haiku sometimes answers around the array (a code fence, a remark,
// a missing item), which made translation fail at random.
const SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false,
}

export const descriptionKey = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)
export const needsTranslation = (text) => Boolean(text.trim()) && !JAPANESE.test(text)

const promptFor = (texts) => 'Translate each description in the JSON array below into Japanese. '
  + 'Keep names, commands, file names, code and URLs unchanged. '
  + 'Return the translations in the same count and order.\n\n' + JSON.stringify(texts)

function checkList(list, count) {
  if (!Array.isArray(list) || list.length !== count || !list.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('翻訳結果の形式が正しくありません')
  }
  return list.map((item) => item.trim())
}

export class SkillTranslator {
  /** @param {{ file?: string, auth?: import('./claude-auth.js').TeamClaudeAuth, codex?: import('./codex-app-server.js').CodexAppServer, cwd?: string, find?: Function, spawn?: Function }} options */
  constructor({ file, auth, codex, cwd, find = findClaude, spawn = spawnProcess }) {
    Object.assign(this, { file, auth, codex, cwd, find, spawn })
    this.running = null
  }

  async cache() {
    return this.file ? readJson(this.file, {}) : {}
  }

  /** Cached Japanese text for each description, or null. */
  async lookup(descriptions) {
    const cache = await this.cache()
    return descriptions.map((text) => cache[descriptionKey(text)] ?? null)
  }

  /** Translates the descriptions that have no cached translation yet; resolves to how many were added. */
  translate(descriptions, engine = 'haiku') {
    if (!ENGINES.includes(engine)) return Promise.reject(new Error('翻訳に使うモデルが正しくありません'))
    const run = (this.running ?? Promise.resolve()).catch(() => {}).then(() => this.#run(descriptions, engine))
    this.running = run
    void run.finally(() => { if (this.running === run) this.running = null }).catch(() => {})
    return run
  }

  async #run(descriptions, engine) {
    const cache = await this.cache()
    const pending = [...new Set(descriptions.filter(needsTranslation))]
      .filter((text) => !cache[descriptionKey(text)]).slice(0, BATCH_MAX)
    if (!pending.length) return 0
    const ask = await this.#start(engine)
    let added = 0
    for (let from = 0; from < pending.length; from += CHUNK) {
      const chunk = pending.slice(from, from + CHUNK)
      const translated = await this.#attempt(ask, chunk.map((text) => text.slice(0, TEXT_MAX)))
      // Re-read: another save may have landed while the model was working.
      const latest = await this.cache()
      chunk.forEach((text, index) => { latest[descriptionKey(text)] = translated[index] })
      await writeJson(this.file, latest)
      added += chunk.length
    }
    return added
  }

  async #attempt(ask, texts) {
    for (let attempt = 1; ; attempt++) {
      try {
        return checkList(await ask(texts), texts.length)
      } catch (error) {
        if (attempt >= ATTEMPTS || !/形式/.test(error.message)) throw error
      }
    }
  }

  /** The function that sends one batch to the chosen model, after the checks that model needs. */
  async #start(engine) {
    if (engine === 'luna') {
      if (!this.codex) throw new Error('Codex が使えません')
      return (texts) => this.codex.askText({
        model: CODEX_MODEL, effort: EFFORT, instructions: SYSTEM, prompt: promptFor(texts), outputSchema: SCHEMA,
      }).then(parseCodexReply)
    }
    const claude = this.find()
    if (!claude) throw new Error('Claude Code（claude コマンド）が見つかりません')
    await fs.mkdir(this.cwd, { recursive: true })
    const problem = await this.auth.guard(null, this.auth.context(this.cwd))
    if (problem) throw new Error(problem)
    return (texts) => this.#askClaude(claude, texts)
  }

  #askClaude(claude, texts) {
    const command = launchCommand(claude, [
      '-p', '--output-format', 'json', '--model', CLAUDE_MODEL, '--effort', EFFORT,
      '--tools', '', '--no-session-persistence', '--disable-slash-commands',
      '--system-prompt', SYSTEM, '--json-schema', JSON.stringify(SCHEMA),
    ])
    return new Promise((resolve, reject) => {
      const proc = this.spawn(command.file, command.args, { cwd: this.cwd, env: claudeAuthEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { proc.kill(); reject(new Error('翻訳がタイムアウトしました')) }, TIMEOUT_MS)
      proc.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      proc.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
      proc.on('error', (error) => { clearTimeout(timer); reject(error) })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(`翻訳に失敗しました: ${stderr.trim() || `exit ${code}`}`))
        try { resolve(JSON.parse(stdout).structured_output?.translations) } catch { reject(new Error('翻訳結果の形式が正しくありません')) }
      })
      proc.stdin.end(promptFor(texts))
    })
  }
}

function parseCodexReply(text) {
  try { return JSON.parse(text).translations } catch { throw new Error('翻訳結果の形式が正しくありません') }
}
