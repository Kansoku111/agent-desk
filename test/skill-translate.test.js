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
      proc.stdout.end(JSON.stringify({ result: reply(prompt) }))
      setImmediate(() => proc.emit('close', 0))
    })
    return proc
  }
}

async function setup(t, { problem = null, reply } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-skill-translate-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = []
  const translator = new SkillTranslator({
    file: path.join(dir, 'translations.json'), cwd: path.join(dir, 'cwd'),
    auth: { context: (cwd) => ({ cwd }), guard: async () => problem },
    find: () => 'claude', spawn: fakeSpawn(reply ?? (() => JSON.stringify(['日本語A'])), calls),
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
  assert.deepEqual(await translator.lookup(['Build agents', 'other']), ['日本語A', null])
  assert.equal(await translator.translate(['Build agents']), 0)
  assert.equal(calls.length, 1)
  assert.equal(descriptionKey('a').length, 24)
})

test('an unconfirmed Claude Code auth mode blocks the call', async (t) => {
  const { translator, calls } = await setup(t, { problem: '認証方法の確認が必要です' })
  await assert.rejects(translator.translate(['Build agents']), /認証方法/)
  assert.equal(calls.length, 0)
})

test('a reply of the wrong shape is rejected and nothing is cached', async (t) => {
  const { translator } = await setup(t, { reply: () => JSON.stringify(['one', 'two']) })
  await assert.rejects(translator.translate(['Build agents']), /形式/)
  assert.deepEqual(await translator.lookup(['Build agents']), [null])
})
