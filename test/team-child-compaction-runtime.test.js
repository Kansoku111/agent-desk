// Real dsh loader/ACP, synthetic token pressure and loopback responses only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import YAML from 'yaml'
import { homePatch, shippedPersona, teamChildPatch } from '../server/dsh-config.js'
import { appPaths } from '../server/paths.js'
import { localRoute } from '../server/local-llm.js'
import { AcpRuntime } from '../server/runtime.js'
import { decodeSessionLog, findSessionLog } from '../server/usage.js'

for (const child of [false, true]) {
  test('real role patch loads the bounded backend only for children (' + (child ? 'child' : 'parent') + ')', { timeout: 120_000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-child-budget-'))
    const paths = appPaths(home), workspace = path.join(home, 'workspace'), runtimes = []
    let requests = 0
    const server = http.createServer(async (req, res) => {
      for await (const _ of req) {} // discard prompts; never persist text or credentials
      requests++
      const base = { id: 'fixture-' + requests, object: 'chat.completion.chunk', created: 0, model: 'budget-fixture' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
      emit({ role: 'assistant', content: 'local fixture done' }); emit({}, 'stop'); res.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(async () => {
      for (const runtime of runtimes) await runtime.stop()
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      assert.equal(path.dirname(home), os.tmpdir())
      assert.match(path.basename(home), /^agent-desk-child-budget-/)
      await fs.rm(home, { recursive: true, force: true })
    })
    await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
    const observer = path.join(home, 'observe.mjs'), observationFile = path.join(home, 'observations.jsonl')
    await fs.writeFile(observationFile, '')
    await fs.writeFile(observer, [
      "import { appendFileSync } from 'node:fs'",
      'const record = value => appendFileSync(' + JSON.stringify(observationFile) + ', JSON.stringify(value) + String.fromCharCode(10))',
      "export const inject = ['compaction', 'tokenMeter']",
      'export function apply(ctx) {',
      '  const measure = ctx.tokenMeter.measure.bind(ctx.tokenMeter)',
      '  const pressure = new WeakMap()',
      "  ctx.on('agent/created', ({ agent }) => { pressure.set(agent.session, 410000) })",
      '  ctx.tokenMeter.measure = (session, options) => {',
      '    const result = measure(session, options)',
      '    return { ...result, totalTokens: pressure.get(session) ?? result.totalTokens, nodes: result.nodes.map(n => ({ ...n, tokens: 100000 })) }',
      '  }',
      '  ctx.compaction.compactRegion = async (start, end, agent) => {',
      '    pressure.set(agent.session, 100000)',
      "    record({ type: 'compacted', backend: ctx.compaction.constructor.name, policy: ctx.compaction.config.modelPolicies })",
      '    return { shadowedSeqs: [start, end], shadowedRange: { start, end }, shadowedTokenCount: 1 }',
      '  }',
      "  ctx.on('agent/pre-step', ({ agent }, next) => { record({ type: 'backend', backend: ctx.compaction.constructor.name, headroom: ctx.compaction.config.headroomTokens, retries: ctx.compaction.config.compactionRetries }); return next() })",
      '}',
    ].join('\n'))
    const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', models: [{ id: 'budget-fixture', contextWindow: 1_000_000 }] }), persona: await shippedPersona() }))
    rows.find(r => r.id === 'acp').config = { provider: 'local-llm', model: 'budget-fixture' }
    rows.push({ id: 'compaction-basic', config: { headroomTokens: 12_345, compactionRetries: 0 } })
    await fs.writeFile(paths.homePatch, YAML.stringify(rows))
    const patches = []
    if (child) { await fs.writeFile(paths.teamChildPatch, teamChildPatch()); patches.push(paths.teamChildPatch) }
    const fixturePatch = path.join(home, 'fixture.patch.yml')
    await fs.writeFile(fixturePatch, YAML.stringify([{ insert: [{ id: 'observe-budget', name: pathToFileURL(observer).href }] }]))
    patches.push(fixturePatch)
    const createRuntime = () => {
      const r = new AcpRuntime({ paths, patches, mode: 'danger-full-access', onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
      runtimes.push(r); return r
    }
    let runtime = createRuntime(); await runtime.start()
    const session = await runtime.newSession(workspace)
    const prompt = async () => assert.equal((await runtime.prompt(session.sessionId, [{ type: 'text', text: 'fixture input' }])).stopReason, 'end_turn')
    await prompt(); await prompt()
    // Resume the persisted request envelope in another process, not a fabricated window.
    await runtime.stop(); runtime = createRuntime(); await runtime.start(); await runtime.resumeSession(session.sessionId, workspace)
    await prompt(); await runtime.stop()
    const events = decodeSessionLog(await fs.readFile(await findSessionLog(paths.dshHome, session.sessionId)))
    const recorded = (await fs.readFile(observationFile, 'utf8')).trim()
    assert.ok(recorded, runtimes.map(r => r.stderr).join('\n'))
    const observations = recorded.split('\n').map(line => JSON.parse(line))
    const backends = observations.filter(e => e.type === 'backend').map(e => e.backend)
    assert.ok(backends.length >= 3)
    assert.ok(observations.filter(e => e.type === 'backend').every(e => e.headroom === 12_345 && e.retries === 0))
    assert.ok(backends.every(name => name === (child ? 'TeamChildCompaction' : 'BasicCompactionEngine')), JSON.stringify(backends))
    const compacted = observations.filter(e => e.type === 'compacted')
    assert.equal(compacted.length, child ? 2 : 0)
    if (child) for (const e of compacted) assert.equal(e.policy.find(p => p.model === 'budget-fixture').thresholdRatio, .4)
    const contexts = events.filter(e => e.type === 'request/context')
    assert.ok(contexts.every(e => e.data.contextWindow === 1_000_000))
    assert.equal(requests, 3) // No extra provider requests for budget checks.
  })
}
