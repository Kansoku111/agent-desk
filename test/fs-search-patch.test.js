import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { patchFsSearchSource } from '../server/fs-search-patch.js'
import { SEARCH_MAX_RECORDS } from '../server/fs-search.js'
import '../server/fs-search-hook.js'

// Dynamic import exercises the actual load hook without changing node_modules.
const search = await import('@deepseek-ai/dsh-tool-fs-search')
const require = createRequire(import.meta.url)
const caps = { maxResults: 100, maxMatches: 250, maxLineBytes: 2000, maxMetaBytes: 65536,
  rawOutputMaxBytes: 20_000_000, graceMs: 1000, stderrMaxBytes: 65536, timeoutMs: 30_000, sampleOverCapGlobResults: false }
const execution = (name, signal = new AbortController().signal) => ({ name, callId: 'call', signal })

function fixture(chunks = [], { exitCode = 0, signal = null, stderr = '', rawOutputMaxBytes, doneError, streamError } = {}) {
  const tools = new Map()
  const hooks = []
  const sections = []
  const saved = []
  const specs = []
  let terminated = 0
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool), get: (name) => tools.get(name) },
    systemPrompt: { section: (section) => sections.push(section), getSectionOrder: () => 0 },
    workingDirectory: { ensure: async () => process.cwd() },
    on: (_event, hook) => hooks.push(hook),
    logger: { warn() {} },
    get: () => ({ saveText: async (input) => { saved.push(input); return { locator: 'saved.txt', retrievalHint: 'Read saved.txt.' } } }),
    subprocess: { spawn(spec) {
      specs.push(spec)
      const stdout = streamError ? new Readable({ read() { this.destroy(new Error('stream failed')) } }) : Readable.from(chunks)
      return { stdout, collected: { stderr: { readFrom: () => ({ text: stderr, lossy: false }) } },
        done: doneError ? Promise.reject(doneError) : Promise.resolve({ exitCode, signal }),
        terminate: () => { terminated++ } }
    } },
  }
  const config = { ...caps, ...(rawOutputMaxBytes === undefined ? {} : { rawOutputMaxBytes }) }
  search.applyGlobTool(ctx, config)
  search.applyGrepTool(ctx, config)
  return { ctx, tools, hooks, sections, saved, specs, get terminated() { return terminated } }
}

async function invoke(f, name, args, exec = execution(name)) {
  const tool = f.tools.get(name)
  const value = await tool.execute(args, exec)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), [])
  const content = tool.output.render(args, value)
  const meta = tool.output.presentationMeta(args, value)
  return { tool, value, text: content.map((part) => part.text).join('\n'), meta }
}
const jsonMatch = (line = 'needle', n = 1) => JSON.stringify({ type: 'match', data: {
  path: { text: 'file.txt' }, lines: { text: `${line}\n` }, line_number: n,
} }) + '\n'

async function postExecute(f, name, value) {
  const exec = { ...execution(name), agent: { session: { header: { id: 'session' } } } }
  let decision = { kind: 'accept' }
  for (const hook of f.hooks) decision = await hook(exec, { value, isError: false }, async () => decision)
  return decision
}

test('the installed search source takes the complete patch; drift and double patching are rejected', async () => {
  const source = await fs.readFile(require.resolve('@deepseek-ai/dsh-tool-fs-search'), 'utf8')
  const patched = patchFsSearchSource(source)
  assert.ok(patched)
  assert.equal(patchFsSearchSource(patched), null)
  assert.equal(patchFsSearchSource('export {}'), null)
  assert.equal(patchFsSearchSource(source.replace('return { matches: all };', 'return upstreamMatches;')), null)
})

test('small searches keep their results, zero matches are success, and guidance starts narrow', async () => {
  const f = fixture(['one.txt\ntwo.txt\n'])
  const glob = await invoke(f, 'glob', { pattern: '*.txt' })
  assert.equal(glob.text, 'one.txt\ntwo.txt')
  assert.equal(glob.value.partial, false)
  assert.equal(glob.meta.truncated, false)
  assert.equal(f.terminated, 0)
  assert.equal(f.specs[0].stdio.stdout, 'pipe')
  assert.equal(f.specs[0].argv[1], '--no-config')
  const none = await invoke(fixture([], { exitCode: 1 }), 'grep', { pattern: 'nothing' })
  assert.equal(none.text, 'No matches found')
  assert.match(f.sections[0].text({ scope: {} }), /Start with a relevant directory/)
  assert.match(f.sections[1].text({ scope: {} }), /Omit include when unused/)
})

test('record limits retain the head and explicitly report an unknown total, not a full artifact', async () => {
  const count = SEARCH_MAX_RECORDS.glob
  const f = fixture([Array.from({ length: count + 1 }, (_, i) => `file-${i}.txt\n`).join('')])
  const result = await invoke(f, 'glob', { pattern: '*' })
  assert.equal(result.value.paths.length, count)
  assert.equal(result.value.paths[0], 'file-0.txt')
  assert.equal(result.value.paths.at(-1), `file-${count - 1}.txt`)
  assert.equal(result.value.partial, true)
  assert.equal(f.terminated, 1)
  assert.match(result.text, /^Partial search:/)
  assert.match(result.text, /total is unknown/)
  assert.match(result.text, /Do not infer.*absent/)
  assert.deepEqual(result.meta, { partial: true })
  assert.equal(result.tool.presentResult({ pattern: '*' }, { meta: result.meta }), undefined)
  assert.deepEqual(await postExecute(f, 'glob', result.value), { kind: 'accept' })
  assert.equal(f.saved.length, 0)
})

test('exact byte/record boundaries are complete until more output actually arrives', async () => {
  assert.equal((await invoke(fixture(['a.txt\n'], { rawOutputMaxBytes: 6 }), 'glob', { pattern: '*' })).value.partial, false)
  const lines = Array.from({ length: SEARCH_MAX_RECORDS.glob }, (_, i) => `p${i}\n`).join('')
  assert.equal((await invoke(fixture([lines]), 'glob', { pattern: '*' })).value.partial, false)
  const partial = await invoke(fixture([lines, 'extra\n']), 'glob', { pattern: '*' })
  assert.equal(partial.value.partial, true)
  assert.equal(partial.value.paths.length, SEARCH_MAX_RECORDS.glob)
})

test('byte cutoffs discard incomplete UTF-8 paths and incomplete grep JSON records', async () => {
  const data = Buffer.from('ok.txt\n猫.txt\n')
  const glob = await invoke(fixture([data.subarray(0, 8), data.subarray(8)], { rawOutputMaxBytes: 9 }), 'glob', { pattern: '*' })
  assert.deepEqual(glob.value.paths, ['ok.txt'])
  assert.equal(glob.value.partial, true)
  assert.doesNotMatch(glob.text, /�/)
  const first = jsonMatch('猫')
  const f = fixture([Buffer.from(first + jsonMatch('other'))], { rawOutputMaxBytes: Buffer.byteLength(first) + 4 })
  const grep = await invoke(f, 'grep', { pattern: '猫' })
  assert.equal(grep.value.partial, true)
  assert.equal(grep.value.matches.length, 1)
  assert.equal(grep.value.matches[0].line, '猫')
  assert.match(grep.text, /total is unknown/)
  await postExecute(f, 'grep', grep.value)
  assert.equal(f.saved.length, 0)
  const empty = await invoke(fixture([jsonMatch('x'.repeat(100))], { rawOutputMaxBytes: 10 }), 'grep', { pattern: 'x' })
  assert.equal(empty.value.matches.length, 0)
  assert.match(empty.text, /^Partial search:/)
  assert.doesNotMatch(empty.text, /No matches found/)
})

test('grep record caps and split JSON chunks still return valid, bounded partial matches', async () => {
  const data = Array.from({ length: SEARCH_MAX_RECORDS.grep + 1 }, (_, i) => jsonMatch('x', i + 1)).join('')
  const result = await invoke(fixture([data.slice(0, 25), data.slice(25)]), 'grep', { pattern: 'x' })
  assert.equal(result.value.partial, true)
  assert.equal(result.value.matches.length, SEARCH_MAX_RECORDS.grep)
  assert.match(result.text, /Showing 250 retained matches/)
})

test('completed over-inline-limit searches still save their full result lists', async () => {
  for (const name of ['glob', 'grep']) {
    const count = name === 'glob' ? 101 : 251
    const f = fixture([Array.from({ length: count }, (_, i) => name === 'glob' ? `p${i}\n` : jsonMatch('x', i + 1)).join('')])
    const result = await invoke(f, name, { pattern: '*' })
    assert.equal(result.value.partial, false)
    const decision = await postExecute(f, name, result.value)
    assert.equal(f.saved.length, 1)
    assert.match(decision.content[0].text, /stored at: saved.txt/)
    assert.doesNotMatch(decision.content[0].text, /Partial search/)
  }
})

test('real errors, invalid inputs and malformed complete records still fail', async () => {
  for (const [options, code] of [
    [{ exitCode: 2, stderr: 'access denied' }, 'SEARCH_FAILED'],
    [{ exitCode: 2, stderr: 'regex parse error' }, 'SEARCH_INVALID_PATTERN'],
    [{ exitCode: null, signal: 'SIGTERM' }, 'SEARCH_FAILED'],
    [{ doneError: new Error('provider failed') }, 'SEARCH_FAILED'],
    [{ streamError: true }, 'SEARCH_FAILED'],
  ]) {
    await assert.rejects(invoke(fixture([], options), 'glob', { pattern: '*' }), (error) => error.code === code)
  }
  const f = fixture(['too much output\n'], { rawOutputMaxBytes: 2, exitCode: 2, stderr: 'access denied' })
  await assert.rejects(invoke(f, 'glob', { pattern: '*' }), /access denied/)
  const diagnostics = fixture(['too much\n'], { rawOutputMaxBytes: 2, exitCode: 1, stderr: 'unreadable directory' })
  await assert.rejects(invoke(diagnostics, 'glob', { pattern: '*' }), /unreadable directory/)
  await assert.rejects(invoke(fixture(['not json\n']), 'grep', { pattern: 'x' }), /malformed/)
  await assert.rejects(invoke(fixture(), 'grep', { pattern: 'x', include: '' }), /non-empty glob/)
  await assert.rejects(invoke(fixture(), 'glob', { pattern: ' ' }), /non-empty string/)
})

test('only output-limit termination is success; caller cancellation always wins', async () => {
  for (const outcome of [{ exitCode: 1 }, { exitCode: null, signal: 'SIGTERM' }, { exitCode: null, signal: 'SIGKILL' }]) {
    const result = await invoke(fixture(['extra\n'], { rawOutputMaxBytes: 2, ...outcome }), 'glob', { pattern: '*' })
    assert.equal(result.value.partial, true)
  }
  const controller = new AbortController()
  controller.abort()
  const before = fixture()
  await assert.rejects(invoke(before, 'glob', { pattern: '*' }, execution('glob', controller.signal)), (error) => error.code === 'SEARCH_ABORTED')
  assert.equal(before.specs.length, 0)
  const during = fixture(['extra\n'], { rawOutputMaxBytes: 2 })
  const spawn = during.ctx.subprocess.spawn
  during.ctx.subprocess.spawn = (spec) => {
    const handle = spawn(spec)
    handle.terminate = () => controller2.abort()
    return handle
  }
  const controller2 = new AbortController()
  await assert.rejects(invoke(during, 'glob', { pattern: '*' }, execution('glob', controller2.signal)), (error) => error.code === 'SEARCH_ABORTED')
})

test('packaged ripgrep and the real managed subprocess seam support bounded glob/grep and true errors', { timeout: 30_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-search-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const context = new Context()
  const subprocess = new LocalSubprocessRuntime(context)
  t.after(() => context.fiber.dispose())
  const f = fixture()
  f.ctx.subprocess = subprocess
  await Promise.all(Array.from({ length: 1005 }, (_, i) => fs.writeFile(path.join(dir, `p${i}.txt`), '')))
  await fs.writeFile(path.join(dir, 'matches.txt'), 'needle\n'.repeat(6000))
  const glob = await invoke(f, 'glob', { pattern: '*.txt', path: dir })
  assert.equal(glob.value.partial, true)
  assert.equal(glob.value.paths.length, 1000)
  const grep = await invoke(f, 'grep', { pattern: 'needle', path: dir })
  assert.equal(grep.value.partial, true)
  assert.ok(grep.value.matches.length > 0 && grep.value.matches.length < 6000)
  await assert.rejects(invoke(f, 'grep', { pattern: '[', path: dir }), (error) => error.code === 'SEARCH_INVALID_PATTERN')
  await assert.rejects(invoke(f, 'glob', { pattern: '*', path: path.join(dir, 'missing') }), /search failed/)
  const none = await invoke(f, 'grep', { pattern: 'absent', path: dir })
  assert.equal(none.text, 'No matches found')
  await fs.writeFile(path.join(dir, '.hidden'), 'hidden')
  await fs.writeFile(path.join(dir, '.gitignore'), '*.ignored\n')
  await fs.writeFile(path.join(dir, 'keep.ignored'), 'ignored')
  assert.match((await invoke(f, 'glob', { pattern: '.hidden', path: dir })).text, /\.hidden/)
  assert.match((await invoke(f, 'glob', { pattern: '*.ignored', path: dir })).text, /keep\.ignored/)
})
