import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { descriptionKey, needsTranslation, SkillTranslator } from '../server/skill-translate.js'

function fakeSpawn(reply, calls) {
  return (file, args, options) => {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.stdin = new PassThrough()
    let prompt = ''
    proc.stdin.on('data', (chunk) => { prompt += chunk })
    proc.stdin.on('end', () => {
      calls.push({ args, options, prompt })
      proc.stdout.end(JSON.stringify({ structured_output: { translations: reply(prompt, calls.length) } }))
      setImmediate(() => proc.emit('close', 0))
    })
    return proc
  }
}

const texts = (prompt) => JSON.parse(prompt.slice(prompt.indexOf('[')))
const japanese = (prompt) => texts(prompt).map((text) => `日本語:${text.slice(0, 12)}`)

async function setup(t, { problem = null, reply, codex } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-skill-translate-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const translator = new SkillTranslator({
    file: path.join(dir, 'translations.json'), cwd: path.join(dir, 'cwd'),
    auth: { context: (cwd) => ({ cwd }), guard: async () => problem }, codex,
    find: () => 'claude', spawn: fakeSpawn(reply ?? japanese, calls),
  })
  return { translator, calls }
}

test('only text without Japanese needs translation', () => {
  assert.equal(needsTranslation('Build agents on Workers'), true)
  assert.equal(needsTranslation('賢いモデル Use when /itak'), false)
  assert.equal(needsTranslation('  '), false)
})

test('translates once with Haiku at low effort and no tools, then serves the cache', async (t) => {
  const { translator, calls } = await setup(t)
  assert.equal(await translator.translate(['Build agents', '日本語の説明', 'Build agents']), 1)
  assert.equal(calls.length, 1)
  const { args, prompt } = calls[0]
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4), ['--model', 'haiku', '--effort', 'low'])
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.ok(prompt.endsWith('["Build agents"]'))
  assert.deepEqual(await translator.lookup(['Build agents', 'other']), ['日本語:Build agents', null])
  assert.equal(await translator.translate(['Build agents']), 0)
  assert.equal(calls.length, 1)
  assert.equal(descriptionKey('a').length, 24)
})

test('long descriptions use the original text for cache lookup', async (t) => {
  const { translator, calls } = await setup(t)
  const description = 'Long description '.repeat(50)
  assert.equal(await translator.translate([description]), 1)
  assert.deepEqual(await translator.lookup([description]), [`日本語:${description.slice(0, 12)}`])
  assert.equal(await translator.translate([description]), 0)
  assert.equal(calls.length, 1)
})

test('concurrent requests translate each distinct set of descriptions', async (t) => {
  const { translator, calls } = await setup(t)
  assert.deepEqual(await Promise.all([translator.translate(['First']), translator.translate(['Second'])]), [1, 1])
  assert.deepEqual(await translator.lookup(['First', 'Second']), ['日本語:First', '日本語:Second'])
  assert.equal(calls.length, 2)
})

test('an unconfirmed Claude Code auth mode blocks the call', async (t) => {
  const { translator, calls } = await setup(t, { problem: '認証方法の確認が必要です' })
  await assert.rejects(translator.translate(['Build agents']), /認証方法/)
  assert.equal(calls.length, 0)
})

test('a reply of the wrong shape is retried once, then rejected with nothing cached', async (t) => {
  const { translator, calls } = await setup(t, { reply: () => ['one', 'two'] })
  await assert.rejects(translator.translate(['Build agents']), /形式/)
  assert.equal(calls.length, 2)
  assert.deepEqual(await translator.lookup(['Build agents']), [null])
})

test('a reply that is right on the retry is cached', async (t) => {
  const { translator, calls } = await setup(t, { reply: (prompt, made) => (made === 1 ? ['one', 'two'] : japanese(prompt)) })
  assert.equal(await translator.translate(['Build agents']), 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(await translator.lookup(['Build agents']), ['日本語:Build agents'])
})

test('descriptions go to the model in batches and finished batches stay cached when a later one fails', async (t) => {
  const { translator, calls } = await setup(t, { reply: (prompt, made) => (made > 1 ? ['one'] : japanese(prompt)) })
  const descriptions = Array.from({ length: 25 }, (_, index) => `Tool ${index}`)
  await assert.rejects(translator.translate(descriptions), /形式/)
  assert.equal(texts(calls[0].prompt).length, 10)
  const cached = (await translator.lookup(descriptions)).filter(Boolean)
  assert.equal(cached.length, 10)
})

test('Luna translates through a Codex turn named for the model at low effort', async (t) => {
  const asked = []
  const codex = { askText: async (options) => { asked.push(options); return JSON.stringify({ translations: ['ルナ訳'] }) } }
  const { translator, calls } = await setup(t, { codex })
  assert.equal(await translator.translate(['Build agents'], 'luna'), 1)
  assert.equal(calls.length, 0)
  assert.equal(asked[0].model, 'gpt-6-luna')
  assert.equal(asked[0].effort, 'low')
  assert.ok(asked[0].prompt.endsWith('["Build agents"]'))
  assert.deepEqual(await translator.lookup(['Build agents']), ['ルナ訳'])
})

test('Luna does not need the Claude Code auth confirmation, and an unknown model is refused', async (t) => {
  const codex = { askText: async () => JSON.stringify({ translations: ['ルナ訳'] }) }
  const { translator } = await setup(t, { problem: '認証方法の確認が必要です', codex })
  assert.equal(await translator.translate(['Build agents'], 'luna'), 1)
  await assert.rejects(translator.translate(['Other'], 'gpt'), /モデル/)
})
