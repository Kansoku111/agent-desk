import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../server/history.js'
import { historyHandler, HISTORY_TOOLS } from '../server/history-mcp.js'
import { createMcpServerList } from '../server/mcp-servers.js'
import { DEFAULT_SETTINGS, migrateSettings, planSettingsUpdate } from '../server/settings.js'
import { abToolAllowed } from '../server/ab-policy-plugin.js'

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-history-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const workspace = path.join(home, 'project-a'), other = path.join(home, 'project-b')
  const write = async (name, data) => {
    const file = path.join(home, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(data))
  }
  const at = Date.parse('2026-06-02T12:00:00Z')
  const turns = [{ id: 'turn-1', startedAt: at, endedAt: at + 1000, revertedBy: 'later',
    user: { text: 'dsh 更新の互換性を確認して', images: [{ data: 'IMAGE_MUST_NOT_LEAK' }] }, items: [
      { type: 'thought', text: 'THOUGHT_MUST_NOT_LEAK' },
      { type: 'tool', input: { secret: 'INPUT_MUST_NOT_LEAK' }, output: 'OUTPUT_MUST_NOT_LEAK' },
      { type: 'agent', text: '更新手順はテストとフック確認です。' },
      { type: 'steer', text: 'Skillはまだ作らないで', at: at + 500 },
    ] }]
  const threads = [{ id: 'a', workspace, title: '更新', updatedAt: at, archived: true },
    { id: 'b', workspace: other, title: '別プロジェクト', updatedAt: at - 1 }]
  await write('threads.json', { version: 1, threads })
  await write('threads/a.json', { turns })
  await write('threads/b.json', { turns: [{ ...turns[0], user: { text: '別プロジェクト限定' } }] })
  const store = new HistoryStore({ home, workspace, claudeHome: path.join(home, 'claude') })
  return { store, home, workspace, other, at, turns, threads, write }
}

test('local history searches only dialogue, defaults to current project, and cites reverted work', async t => {
  const f = await fixture(t)
  const result = await f.store.search({ query: 'DSH 更新', role: 'user' })
  assert.equal(result.results.length, 1)
  const hit = result.results[0]
  assert.equal(hit.session_id, 'thread:a')
  assert.equal(hit.message, 0)
  assert.equal(hit.reverted, true)
  assert.equal(hit.archived, true)
  assert.match(result.notice, /not current instructions/)
  assert.equal((await f.store.search({ query: '別プロジェクト限定' })).results.length, 0)
  assert.equal((await f.store.search({ query: '別プロジェクト限定', all_workspaces: true })).results.length, 1)
  assert.equal((await f.store.search({ query: '別プロジェクト限定', workspace: f.other })).results.length, 1)
  assert.equal((await f.store.search({ query: 'MUST_NOT_LEAK', all_workspaces: true })).results.length, 0)
  const read = await f.store.read({ session_id: hit.session_id, message: hit.message })
  assert.equal(read.text, f.turns[0].user.text)
  assert.equal(read.next_message, 1)
  assert.equal(read.message_count, 3)
  assert.doesNotMatch(JSON.stringify(read), /MUST_NOT_LEAK/)
  assert.equal((await f.store.search({ role: 'assistant' })).results.length, 1)
  assert.equal((await f.store.search({ query: 'まだ作らない' })).results[0].role, 'user')
})

test('search pagination, dates, snippets and chunked read bound returned text', async t => {
  const f = await fixture(t)
  const first = await f.store.search({ limit: 1 })
  assert.equal(first.results.length, 1)
  assert.equal(first.truncated, true)
  assert.equal(first.next_offset, 1)
  const next = await f.store.search({ limit: 1, offset: first.next_offset })
  assert.equal(next.results[0].message, 1)
  assert.equal((await f.store.search({ since: '2026-06-02', until: '2026-06-02' })).results.length, 3)
  assert.equal((await f.store.search({ since: '2026-06-03' })).results.length, 0)
  assert.equal((await f.store.search({ until: '2026-06-01' })).results.length, 0)
  const long = '先頭'.repeat(5000) + 'needle' + '末尾'.repeat(5000)
  await f.write('threads/a.json', { turns: [{ ...f.turns[0], user: { text: long } }] })
  const hit = (await f.store.search({ query: 'needle' })).results[0]
  assert.equal(hit.snippet.length, 320)
  assert.match(hit.snippet, /needle/)
  const read = await f.store.read({ session_id: 'thread:a', offset: hit.char_offset, max_chars: 320 })
  assert.equal(read.text, hit.snippet)
  assert.equal(read.next_offset, hit.char_offset + 320)
  const chunk = await f.store.read({ session_id: 'thread:a' })
  assert.equal(chunk.text.length, 4000)
  assert.equal(chunk.total_chars, long.length)
  const end = await f.store.read({ session_id: 'thread:a', offset: long.length - 5 })
  assert.equal(end.text.length, 5)
  assert.equal(end.next_offset, null)
})

test('invalid inputs, arbitrary paths, deleted tasks and broken files are handled explicitly', async t => {
  const f = await fixture(t)
  for (const args of [{ query: 1 }, { query: 'x'.repeat(201) }, { limit: 21 }, { limit: 0 }, { offset: -1 },
    { role: 'system' }, { all_workspaces: 'yes' }, { workspace: 1 }, { since: '2026-02-30' },
    { since: '2026-06-03', until: '2026-06-02' }]) await assert.rejects(f.store.search(args))
  for (const args of [{ session_id: '../settings.json' }, { session_id: 'thread:../a' },
    { session_id: 'thread:a', max_chars: 12001 }, { session_id: 'thread:a', message: -1 },
    { session_id: 'thread:a', offset: '0' }, { session_id: 'thread:a', message: 99 }]) await assert.rejects(f.store.read(args))
  await f.write('threads.json', { threads: [] })
  await assert.rejects(f.store.read({ session_id: 'thread:a' }), /not found/)
  await f.write('threads.json', { threads: f.threads })
  await fs.writeFile(path.join(f.home, 'threads/a.json'), '{broken')
  const result = await f.store.search({ all_workspaces: true })
  assert.equal(result.skipped_sessions, 1)
  assert.ok(result.results.length > 0)
  await assert.rejects(f.store.read({ session_id: 'thread:a' }))
})

test('registered CL transcripts include old messages, but exclude tools, metadata and unrelated sessions', async t => {
  const f = await fixture(t)
  const dir = path.join(f.home, 'claude/projects/a')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'cl-session.jsonl')
  const entries = Array.from({ length: 85 }, (_, i) => ({ type: 'user', uuid: 'u-' + i,
    timestamp: '2026-06-02T12:00:00Z', message: { content: 'CL request ' + i } }))
  entries.push({ type: 'assistant', uuid: 'answer', message: { content: [
    { type: 'thinking', thinking: 'CL_SECRET_THOUGHT' }, { type: 'text', text: 'CL answer' },
    { type: 'tool_use', input: { text: 'CL_SECRET_INPUT' } },
  ] } }, { type: 'user', isMeta: true, message: { content: 'CL_SECRET_META' } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'CL_SECRET_OUTPUT' }] } })
  await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{partial')
  await f.write('terminals.json', { terminals: [{ id: 'cl', workspace: f.workspace, sessionId: 'cl-session', title: 'CL task' }] })
  const hit = (await f.store.search({ query: 'CL request 0' })).results[0]
  assert.equal(hit.session_id, 'terminal:cl')
  assert.equal(hit.message, 0)
  assert.equal((await f.store.read({ session_id: hit.session_id })).text, 'CL request 0')
  assert.equal((await f.store.search({ query: 'CL_SECRET' })).results.length, 0)
  assert.equal((await f.store.search({ query: 'CL answer' })).results[0].role, 'assistant')
  assert.equal((await f.store.search({ query: 'CL answer' })).skipped_messages, 1)
  await f.write('terminals.json', { terminals: [] })
  assert.equal((await f.store.search({ query: 'CL request' })).results.length, 0)
})

test('team children expose retained conversation text, not launch configuration', async t => {
  const f = await fixture(t)
  await f.write('team-agents/child.json', { id: 'child', workspace: f.workspace,
    args: ['TEAM_SECRET'], turns: [{ ...f.turns[0], user: { text: 'チームの作業手順' } }] })
  const result = await f.store.search({ query: 'チームの作業手順' })
  assert.equal(result.results[0].session_id, 'team:child')
  assert.match(result.results[0].retention, /60/)
  const read = await f.store.read({ session_id: 'team:child' })
  assert.equal(read.text, 'チームの作業手順')
  assert.doesNotMatch(JSON.stringify(read), /TEAM_SECRET/)
})

test('history switch is opt-in, validates booleans and triggers the existing idle restart', () => {
  assert.equal(DEFAULT_SETTINGS.historyTool, false)
  assert.equal(migrateSettings({}).historyTool, false)
  assert.throws(() => planSettingsUpdate(DEFAULT_SETTINGS, { historyTool: 'true' }))
  const updated = planSettingsUpdate(DEFAULT_SETTINGS, { historyTool: true })
  assert.equal(updated.settings.historyTool, true)
  assert.equal(updated.effects.restart, true)
  assert.equal(planSettingsUpdate(updated.settings, { historyTool: false }).effects.restart, true)
  const paths = { home: 'app-home', settings: 'settings.json' }
  let settings = { historyTool: false }
  const servers = createMcpServerList({ paths, getSettings: () => settings, getTeams: () => null })
  assert.deepEqual(servers({ workspace: 'project' }), [])
  settings = { historyTool: true }
  const mounted = servers({ workspace: 'project' })
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].name, 'history')
  assert.deepEqual(mounted[0].args.slice(-6), ['--home', 'app-home', '--settings', 'settings.json', '--workspace', 'project'])
  assert.deepEqual(servers({ workspace: 'project', ab: { writable: false } }), [])
  assert.equal(abToolAllowed('mcp__history__read', true), true)
  assert.equal(abToolAllowed('mcp__history__read', false), false)
})

test('MCP hides definitions while off, checks revocation and returns bounded data only on request', async () => {
  let on = false, calls = 0
  const handler = historyHandler({ enabled: async () => on, store: {
    search: async () => { calls++; return { results: [] } },
    read: async () => { calls++; on = false; return { text: 'revoked data' } },
  } })
  const request = (name, args = {}) => handler({ method: 'tools/call', params: { name, arguments: args } })
  assert.equal((await handler({ method: 'initialize', params: {} })).instructions, undefined)
  assert.deepEqual((await handler({ method: 'tools/list' })).tools, [])
  assert.equal((await request('search')).isError, true)
  assert.equal(calls, 0)
  on = true
  assert.deepEqual((await handler({ method: 'tools/list' })).tools, HISTORY_TOOLS)
  assert.equal((await request('search')).isError, undefined)
  assert.equal(calls, 1)
  assert.equal((await request('search', { file: 'arbitrary' })).isError, true)
  assert.equal((await request('delete')).isError, true)
  const read = await request('read', { session_id: 'thread:a' })
  assert.equal(read.isError, true)
  assert.doesNotMatch(JSON.stringify(read), /revoked data/)
})

test('history stdio MCP honors persisted on/off without a model call', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  await f.write('settings.json', { historyTool: true })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/history-mcp.js', import.meta.url)),
    '--home', f.home, '--settings', path.join(f.home, 'settings.json'), '--workspace', f.workspace],
  { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  let seq = 0, stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolve => child.on('exit', resolve))
  child.on('exit', code => {
    for (const { reject } of waiting.values()) reject(new Error('MCP exited: ' + code + ' ' + stderr))
    waiting.clear()
  })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.resolve(message)
    waiting.delete(message.id)
  })
  t.after(() => { lines.close(); child.kill() })
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  assert.equal((await request('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18')
  assert.equal((await request('tools/list')).result.tools.length, 2)
  const search = await request('tools/call', { name: 'search', arguments: { query: '互換性' } })
  const result = JSON.parse(search.result.content[0].text)
  assert.equal(result.results[0].session_id, 'thread:a')
  const read = await request('tools/call', { name: 'read', arguments: { session_id: 'thread:a', message: 0, max_chars: 5 } })
  assert.equal(JSON.parse(read.result.content[0].text).text.length, 5)
  await f.write('settings.json', { historyTool: false })
  assert.deepEqual((await request('tools/list')).result.tools, [])
  assert.equal((await request('tools/call', { name: 'search' })).result.isError, true)
  await fs.writeFile(path.join(f.home, 'settings.json'), '{broken')
  assert.deepEqual((await request('tools/list')).result.tools, [])
  child.stdin.end()
  assert.equal(await exited, 0)
})

