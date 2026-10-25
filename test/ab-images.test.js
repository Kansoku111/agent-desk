import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { abImages, assertAbImageModels, claudeImageBlocks } from '../server/ab-images.js'
import { AbManager } from '../server/ab.js'
import { AbRunner } from '../server/ab-runner.js'
import { ClaudeRunner } from '../server/claude-runner.js'
import { abTimeline, abMarkdown } from '../web/src/ab-transcript.ts'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-images-'))
  const cleanups = []
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  const images = [{ file: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', mimeType: 'image/png', name: 'first.png' },
    { file: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png', mimeType: 'image/png', name: 'second.png' }]
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  for (const image of images) await fs.writeFile(path.join(dir, image.file), bytes)
  return { dir, images, bytes, cleanups }
}

test('AB validates uploaded IDs, MIME, existence and bounds rather than trusting paths', async (t) => {
  const { dir, images } = await fixture(t)
  assert.deepEqual(await abImages(dir, [{ ...images[0], mimeType: 'text/plain' }]), [images[0]])
  for (const value of [null, {}, [{ file: '../private.png' }], [{ file: 'ccc.png' }], Array(21).fill(images[0])]) await assert.rejects(abImages(dir, value))
  assert.deepEqual((await claudeImageBlocks(dir, images)).map((block) => block.source.media_type), ['image/png', 'image/png'])
})

test('AB images survive all stages, image-only follow-ups, retries and reload without approval bypass', async (t) => {
  const { dir, images } = await fixture(t)
  const calls = []
  const runner = Object.assign(new EventEmitter(), { async start(input) { calls.push(input); return { id: input.jobId } }, async stop() {} })
  const options = { dir, runner, validateImages: (images) => abImages(dir, images) }
  const manager = await new AbManager(options).load()
  const { run: created } = await manager.create({ workspace: dir, text: '', images: [images[0]], config: { a: 'A', b: 'B', leader: 'L', implementer: 'I' } })
  const run = manager.require(created.id)
  const finish = async (role, status = 'completed') => manager.finished({ runId: run.id, jobId: run.jobs.findLast((job) => job.role === role).id, text: `${role} report`, status })
  assert.deepEqual(calls.map((call) => [call.text, call.images]), [['', [images[0]]], ['', [images[0]]]])
  await finish('a'); await finish('b'); await finish('leader')
  await assert.rejects(manager.revise({ id: run.id, text: '', images: [{ file: '../no.png' }] }))
  assert.equal(run.messages.length, 0)
  const oldRevision = run.revision
  await manager.revise({ id: run.id, text: '', images: [images[1]] })
  assert.equal(calls.at(-1).writable, false)
  assert.deepEqual(calls.at(-1).images, images)
  await assert.rejects(manager.approve({ id: run.id, revision: oldRevision, delegate: true, review: true }))
  await finish('leader')
  await manager.approve({ id: run.id, revision: run.revision, delegate: true, review: true })
  await finish('instructions'); await finish('implementer', 'error')
  await manager.retry({ id: run.id, jobId: run.jobs.at(-1).id })
  await finish('implementer'); await finish('reviewer')
  assert.ok(calls.slice(2).every((call) => call.images.some((image) => image.file === images[0].file)))
  assert.ok(calls.slice(3).every((call) => call.images.length === 2))
  const restored = (await new AbManager(options).load()).require(run.id)
  assert.deepEqual(restored.images, [images[0]])
  assert.deepEqual(restored.messages[0].images, [images[1]])
  assert.deepEqual(abTimeline(restored).find((entry) => entry.kind === 'message').images, [images[1]])
  assert.match(abMarkdown(restored), /first\.png/)
  assert.match(abMarkdown(restored), /second\.png/)
})

for (const preflight of [false, true]) test(`AB Claude backend writes actual base64 image blocks to stdin (preflight=${preflight})`, async (t) => {
  const { dir, images, bytes, cleanups } = await fixture(t)
  let proc, stdin = ''
  const agents = await new ClaudeRunner({ dir: path.join(dir, 'agents'), findClaude: () => 'claude',
    ...(preflight ? { preflight: async () => null } : {}),
    spawn: () => {
      proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 12 })
      proc.stdin.on('data', (chunk) => { stdin += chunk })
      proc.kill = () => { setImmediate(() => proc.emit('close', 0)) }
      return proc
    },
  }).load()
  cleanups.push(() => agents.shutdown())
  const runner = new AbRunner({ agents, threads: new EventEmitter(), attachmentsDir: dir })
  const handle = await runner.start({ runId: 'R', jobId: 'J', workspace: dir, model: 'claude:sonnet', text: 'original', images, instructions: 'readonly', writable: false })
  // Preflight and process attachment run asynchronously.
  await new Promise((resolve) => setImmediate(resolve))
  const content = JSON.parse(stdin).message.content
  assert.deepEqual(content[0], { type: 'text', text: 'original' })
  assert.equal(content.length, 3)
  assert.equal(content[1].source.type, 'base64')
  assert.equal(content[1].source.data, bytes.toString('base64'))
  assert.deepEqual(agents.turns(handle.id)[0].user.images, images)
  const ended = once(runner, 'finished')
  proc.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'seen', is_error: false }) + '\n')
  proc.emit('close', 0)
  assert.equal((await ended)[0].text, 'seen')
})

test('AB DSH backend receives image references with unchanged original text', async (t) => {
  const { images } = await fixture(t)
  let received
  const threads = Object.assign(new EventEmitter(), { async create() { return { id: 'T' } }, async send(_id, input) { received = input } })
  const { AB_CONSULT } = await import('../server/ab.js')
  await new AbRunner({ threads, agents: new EventEmitter() }).start({ runId: 'R', jobId: 'J', workspace: '/project', model: 'model', text: 'raw original', images, instructions: AB_CONSULT })
  assert.deepEqual(received, { text: 'raw original', images })
})


test('AB through the real ThreadManager sends image bytes as ACP image blocks', async (t) => {
  const { fixture: threadFixture } = await import('./helpers/thread-manager.js')
  const f = await threadFixture(t)
  const { images, bytes } = await fixture(t)
  await fs.mkdir(f.paths.attachmentsDir, { recursive: true })
  await fs.writeFile(path.join(f.paths.attachmentsDir, images[0].file), bytes)
  const { AB_CONSULT } = await import('../server/ab.js')
  const runner = new AbRunner({ threads: f.manager, agents: new EventEmitter() })
  const done = once(runner, 'finished')
  await runner.start({ runId: 'R', jobId: 'J', workspace: f.base, model: '["test","model"]', text: 'original', images: [images[0]], instructions: AB_CONSULT })
  await f.started.promise
  assert.deepEqual(f.calls.prompts[0].blocks, [{ type: 'text', text: 'original' }, { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }])
  f.finish.resolve()
  await done
})

test('AB rejects image input for unknown/text-only routes, including a newly enabled implementer', () => {
  const models = [{ value: 'gpt', provider: 'openai-codex' }, { value: 'api', provider: 'anthropic' }, { value: 'text', provider: 'deepseek-official' }]
  const config = { a: 'claude:opus', b: 'gpt', leader: 'api', implementer: 'text', delegate: false }
  assert.doesNotThrow(() => assertAbImageModels(config, models))
  assert.throws(() => assertAbImageModels({ ...config, delegate: true }, models), /画像入力/)
  assert.throws(() => assertAbImageModels({ ...config, a: 'text' }, models), /画像入力/)
  assert.throws(() => assertAbImageModels({ ...config, leader: 'unknown' }, models), /画像入力/)
})
