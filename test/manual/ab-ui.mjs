// Local-only AB UI harness. Uses the real state machine with fake model results; never calls providers.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { DEFAULT_SETTINGS } from '../../server/settings.js'
import { AbManager } from '../../server/ab.js'
import { PROVIDER_LABELS } from '../../server/catalog.js'
import { createAbHandlers } from '../../server/rpc-handlers-ab.js'
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ab-ui-'))
const workspace = path.join(dir, 'project')
await fs.mkdir(workspace)
const root = path.resolve('web/dist')
const runner = new EventEmitter()
const calls = []
const notifications = []
let failOnce = process.env.AB_FIXTURE_FAIL_ONCE === '1'
const denials = process.env.AB_FIXTURE_DENIALS === '1' ? ['Bash: fixture-only blocked operation'] : []
const timers = new Map()
runner.start = async (input) => {
  calls.push(input)
  const report = input.writable ? '## 実装報告\n- 対象ファイルを変更\n- テスト：成功（UI用の模擬報告）' : input.instructions.includes('吟味') ? '## 提案\n独立した2社の検討結果から、段階的に導入する案を推奨します。\n\n### 採用理由\n変更範囲を小さく保てます。\n\n### 残る懸念\n性能は未確認です。' : '## 検討結果\n読み取り専用で調査する方針です。\n\n- 根拠：模擬資料\n- 懸念：実環境の検証が必要'
  const fail = input.writable && failOnce
  if (fail) failOnce = false
  timers.set(input.jobId, setTimeout(() => {
    timers.delete(input.jobId)
    runner.emit('finished', { runId: input.runId, jobId: input.jobId,
      status: fail ? 'error' : 'completed', text: report, error: fail ? 'fixture: implementation interrupted' : undefined,
      denials: input.writable && input.permissionMode !== 'danger-full-access' ? denials : [] })
  }, 600))
  return { id: input.jobId, kind: 'fake' }
}
runner.stop = async (handle) => { clearTimeout(timers.get(handle?.id)); timers.delete(handle?.id) }
runner.remove = runner.stop
const ab = await new AbManager({ dir, runner }).load()
const config = { a: '["anthropic","claude-test"]', b: '["openai-codex","gpt-test"]', leader: '["openai-codex","gpt-test"]', implementer: '["anthropic","haiku-test"]', lean: true, delegate: true, review: true }
await ab.configure(config)
const state = {
  app: { version: 'test', dshVersion: 'test', platform: 'win32', dataDir: dir, myPc: workspace, uiBuild: 'fixture', remote: false },
  settings: { ...structuredClone(DEFAULT_SETTINGS), workspaces: [workspace] },
  accounts: { chatgpt: { signedIn: true }, codex: { signedIn: false }, claude: { configured: true }, deepseek: { configured: false }, claudeAdmin: { configured: false }, error: null },
  catalog: { providers: PROVIDER_LABELS, models: [
    { value: config.a, id: 'claude-test', name: 'Claude（テスト）', provider: 'anthropic' },
    { value: config.b, id: 'gpt-test', name: 'GPT（テスト）', provider: 'openai-codex' },
    { value: config.implementer, id: 'haiku-test', name: 'Haiku（テスト）', provider: 'anthropic' },
  ], effortsByModel: {}, fallbackEfforts: [] }, fastModels: {}, threads: [], terminals: [], teams: [], ab: [], runtime: {},
  login: { phase: 'idle' }, chatgptUsage: null, claudeLimits: null,
  usage: { local: null, claude: { status: 'none', summary: null } }, openTargets: {}, permissionModes: ['read-only', 'workspace-write'],
  updates: { checking: false, dsh: {}, codex: {}, claude: {}, app: null },
  modelUpdate: { phase: 'idle', models: [], account: { retired: [] } }, remoteAccess: { enabled: false },
}
const wss = new WebSocketServer({ noServer: true })
const broadcast = (event) => { for (const socket of wss.clients) socket.send(JSON.stringify(event)) }
ab.on('ab', (run) => { state.ab = ab.list(); broadcast({ event: 'ab', run }) })
ab.on('removed', ({ id }) => { state.ab = ab.list(); broadcast({ event: 'abRemoved', id }) })
ab.on('fault', console.error)
ab.on('notify', (event) => { notifications.push(event); broadcast({ event: 'notify', ...event }) })
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/fixture/notifications') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(notifications)); return }
  // A server-state change the page re-renders for (usage broadcasts happen on their own in the app).
  if (url.pathname === '/fixture/poke') { broadcast({ event: 'usage', usage: { ...state.usage, tick: Date.now() } }); res.end('ok'); return }
  if (url.pathname === '/fixture/calls') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(calls)); return }
  if (url.pathname === '/fixture/shutdown') {
    await ab.shutdown(); res.end('stopped'); for (const socket of wss.clients) socket.terminate(); wss.close(); server.close();
    // This directory was created by this process exclusively for the fixture.
    await fs.rm(dir, { recursive: true, force: true }); return
  }
  const target = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
  if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
  try {
    const body = await fs.readFile(target)
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(target)] ?? 'application/octet-stream')
    res.end(body)
  } catch { res.writeHead(404); res.end() }
})
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client)))
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ event: 'hello', state }))
  socket.on('message', async (raw) => {
    const request = JSON.parse(String(raw))
    try {
      const handler = createAbHandlers(ab)[request.type]
      const result = handler ? await handler(request) : {}
      socket.send(JSON.stringify({ id: request.id, ok: true, result }))
    } catch (error) { socket.send(JSON.stringify({ id: request.id, ok: false, error: error.message })) }
  })
})
server.listen(0, '127.0.0.1', () => console.log(`AB_UI_URL=http://127.0.0.1:${server.address().port}/?t=fixture`))
