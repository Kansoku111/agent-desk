// Real dsh/ACP/compaction and persistence, synthetic pressure, loopback model only.
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
  test('oversized-head pressure compacts, continues and resumes (' + (child ? 'child' : 'parent') + ')', { timeout: 120000 }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-context-compaction-'))
    const paths = appPaths(home), workspace = path.join(home, 'workspace'), runtimes = [], requests = []
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const input = JSON.parse(body)
      const summary = JSON.stringify(input.messages.at(-1)).includes('Output only the checkpoint text')
      requests.push({ summary, messages: input.messages })
      const text = summary ? '## Goal\nKeep the fixture task running.\n## Next Step\nAnswer the next request.' : 'fixture answer'
      const base = { id: 'fixture-' + requests.length, object: 'chat.completion.chunk', created: 0, model: 'context-fixture' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
      emit({ role: 'assistant', content: text }); emit({}, 'stop'); res.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(async () => {
      for (const runtime of runtimes) await runtime.stop()
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      assert.equal(path.dirname(home), os.tmpdir())
      assert.match(path.basename(home), /^agent-desk-context-compaction-/)
      await fs.rm(home, { recursive: true, force: true })
    })
    await fs.mkdir(paths.dshHome, { recursive: true }); await fs.mkdir(workspace)
    const observer = path.join(home, 'pressure.mjs')
    await fs.writeFile(observer, [
      "export const inject = ['tokenMeter']",
      'export function apply(ctx) {',
      '  const measure = ctx.tokenMeter.measure.bind(ctx.tokenMeter)',
      '  ctx.tokenMeter.measure = (session, header) => {',
      '    const result = measure(session, header)',
      "    const head = session.surface.nodes.find(seq => { const e = session.eventAt(seq); return e.type === 'user/message' && e.data.content.some(b => b.text?.startsWith('imported fixture history')) })",
      '    if (head === undefined || !session.requestHeader()) return result',
      '    return { ...result, totalTokens: 511280, nodes: result.nodes.map(n => ({ ...n, tokens: n.seq === head ? 204135 : 5000 })) }',
      '  }',
      '}',
    ].join('\n'))
    const rows = YAML.parse(homePatch({ localRoute: localRoute({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1',
      models: [{ id: 'context-fixture', contextWindow: 500000, maxTokens: 32768 }] }), persona: await shippedPersona() }))
    rows.find(r => r.id === 'acp').config = { provider: 'local-llm', model: 'context-fixture' }
    await fs.writeFile(paths.homePatch, YAML.stringify(rows))
    const patches = []
    if (child) { await fs.writeFile(paths.teamChildPatch, teamChildPatch()); patches.push(paths.teamChildPatch) }
    const fixturePatch = path.join(home, 'fixture.patch.yml')
    await fs.writeFile(fixturePatch, YAML.stringify([{ insert: [{ id: 'fixture-pressure', name: pathToFileURL(observer).href }] }]))
    patches.push(fixturePatch)
    const createRuntime = () => {
      const runtime = new AcpRuntime({ paths, patches, mode: 'danger-full-access', onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
      runtimes.push(runtime); return runtime
    }
    let runtime = createRuntime(); await runtime.start()
    const session = await runtime.newSession(workspace)
    const prompt = async text => assert.equal((await runtime.prompt(session.sessionId, [{ type: 'text', text }])).stopReason, 'end_turn', runtime.stderr)
    await prompt('imported fixture history '.repeat(400))
    await prompt('continue fixture task')
    await runtime.stop(); runtime = createRuntime(); await runtime.start(); await runtime.resumeSession(session.sessionId, workspace)
    await prompt('resume fixture task'); await runtime.stop()
    const events = decodeSessionLog(await fs.readFile(await findSessionLog(paths.dshHome, session.sessionId)))
    const summaries = events.filter(e => e.type === 'compaction/summary')
    assert.equal(summaries.length, 1, runtimes.map(r => r.stderr).join('\n'))
    assert.equal(events.filter(e => e.type === 'compaction/end' && e.data.error).length, 0)
    assert.equal(events.filter(e => e.type === 'turn/end' && e.data.reason.kind === 'error').length, 0)
    assert.equal(requests.filter(r => r.summary).length, 1)
    assert.equal(requests.length, 4) // Three ordinary replies and exactly one real summary.
    const resumed = JSON.stringify(requests.at(-1).messages)
    assert.match(resumed, /Keep the fixture task running/)
    assert.match(resumed, /resume fixture task/)
    assert.doesNotMatch(resumed, /imported fixture history/)
  })
}
