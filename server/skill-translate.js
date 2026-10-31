// Japanese descriptions for skills written in other languages (Settings → Skills).
// One Claude Code `-p` call (Haiku, low effort, no tools) translates the
// untranslated descriptions of a project; results are cached by description text.
// It runs only when the user presses the button, and only under a Claude Code
// auth mode the user has already confirmed for agent teams: this is a billed model call.
import { spawn as spawnProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { claudeAuthEnv } from './claude-auth.js'
import { readJson, writeJson } from './json-file.js'
import { findClaude, launchCommand } from './terminal-helpers.js'

const MODEL = 'haiku'
const EFFORT = 'low'
const TIMEOUT_MS = 90_000
const BATCH_MAX = 40
const TEXT_MAX = 600
const JAPANESE = /[぀-ヿ㐀-鿿]/

export const descriptionKey = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)
export const needsTranslation = (text) => Boolean(text.trim()) && !JAPANESE.test(text)

function parseReply(stdout, count) {
  const result = JSON.parse(stdout).result
  const list = JSON.parse(result.slice(result.indexOf('['), result.lastIndexOf(']') + 1))
  if (!Array.isArray(list) || list.length !== count || !list.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('翻訳結果の形式が正しくありません')
  }
  return list.map((item) => item.trim())
}

export class SkillTranslator {
  /** @param {{ file?: string, auth?: import('./claude-auth.js').TeamClaudeAuth, cwd?: string, find?: Function, spawn?: Function }} options */
  constructor({ file, auth, cwd, find = findClaude, spawn = spawnProcess }) {
    Object.assign(this, { file, auth, cwd, find, spawn })
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
  translate(descriptions) {
    this.running ??= this.#run(descriptions).finally(() => { this.running = null })
    return this.running
  }

  async #run(descriptions) {
    const cache = await this.cache()
    const pending = [...new Set(descriptions.filter(needsTranslation).map((text) => text.slice(0, TEXT_MAX)))]
      .filter((text) => !cache[descriptionKey(text)]).slice(0, BATCH_MAX)
    if (!pending.length) return 0
    const claude = this.find()
    if (!claude) throw new Error('Claude Code（claude コマンド）が見つかりません')
    await fs.mkdir(this.cwd, { recursive: true })
    const problem = await this.auth.guard(null, this.auth.context(this.cwd))
    if (problem) throw new Error(problem)
    const translated = parseReply(await this.#ask(claude, pending), pending.length)
    // Re-read: another save may have landed while the model was working.
    const latest = await this.cache()
    pending.forEach((text, index) => { latest[descriptionKey(text)] = translated[index] })
    await writeJson(this.file, latest)
    return pending.length
  }

  #ask(claude, texts) {
    const command = launchCommand(claude, [
      '-p', '--output-format', 'json', '--model', MODEL, '--effort', EFFORT,
      '--tools', '', '--no-session-persistence', '--disable-slash-commands',
    ])
    const prompt = 'Translate each software tool description in the JSON array below into natural Japanese. '
      + 'Keep names, commands, file names, code and URLs unchanged. '
      + 'Reply with only a JSON array of strings, the same length and order.\n\n' + JSON.stringify(texts)
    return new Promise((resolve, reject) => {
      const proc = this.spawn(command.file, command.args, { cwd: this.cwd, env: claudeAuthEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { proc.kill(); reject(new Error('翻訳がタイムアウトしました')) }, TIMEOUT_MS)
      proc.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      proc.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
      proc.on('error', (error) => { clearTimeout(timer); reject(error) })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(`翻訳に失敗しました: ${stderr.trim() || `exit ${code}`}`))
      })
      proc.stdin.end(prompt)
    })
  }
}
