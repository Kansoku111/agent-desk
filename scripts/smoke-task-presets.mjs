// Explicit, billed smoke check. Never included in npm test.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AcpRuntime } from '../server/runtime.js'
import { appPaths } from '../server/paths.js'
import { newTurn, applyUpdate, parseConfigOptions } from '../server/transcript.js'
import { ClaudeRunner } from '../server/claude-runner.js'
import { abClaudeArgs } from '../server/ab-runner.js'
import { authDescriptor, claudeAuthStatus } from '../server/claude-auth.js'
import { findClaude, TerminalManager } from '../server/terminals.js'
import http from 'node:http'
import { preparePresetPrompt, parsePresetBrief, matchesPresetPrompt } from '../server/task-preset-protocol.js'
const provider = process.argv[2]
if (!['gpt', 'claude', 'terminal'].includes(provider)) throw new Error('Usage: node scripts/smoke-task-presets.mjs gpt|claude|terminal (starts a billed model turn)')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-live-'))
const run = { id: randomUUID(), kind: 'review', instruction: '合意済み要件: add(a,b)が和を返す。対象はsource.jsとそのテスト。新機能は不要。問題があれば修正しnode --testで検証する。指示をまとめるだけで、今回コードを読んだり変更したりしない。' }
const prompt = preparePresetPrompt(run)
let rejectDeadline
const deadline = new Promise((_, reject) => { rejectDeadline = reject })
void deadline.catch(() => {})
const timeout = setTimeout(() => rejectDeadline(new Error('Smoke check timed out')), 100_000)
try {
  if (provider === 'gpt') {
    const turn = newTurn({ id: randomUUID(), text: prompt, images: [] })
    const runtime = new AcpRuntime({ mode: 'read-only', paths: appPaths(), onUpdate: (_id, update) => applyUpdate(turn, update), onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
    try {
      await runtime.start()
      const session = await runtime.newSession(root, [])
      const model = JSON.stringify(['openai-codex', 'gpt-6-luna'])
      const modelOptions = await runtime.setOption(session.sessionId, 'model', model)
      assert.equal(parseConfigOptions(modelOptions).currentModel, model)
      const effortOptions = await runtime.setOption(session.sessionId, 'reasoning_effort', 'low')
      assert.equal(parseConfigOptions(effortOptions).currentEffort, 'low')
      await runtime.setGoalWaiting(session.sessionId, true)
      await Promise.race([runtime.prompt(session.sessionId, [{ type: 'text', text: prompt }]), deadline])
      const text = turn.items.filter((item) => item.type === 'agent').at(-1)?.text
      const result = parsePresetBrief(text, run)
      assert.equal(result.status, 'ready')
      console.log(JSON.stringify({ provider, model: 'gpt-6-luna', effort: 'low', parsed: result.status, briefChars: result.brief.length, toolCalls: turn.items.filter((item) => item.type === 'tool').length }))
    } finally { await runtime.stop() }
  } else if (provider === 'claude') {
    const cli = findClaude()
    const descriptor = authDescriptor(await claudeAuthStatus({ claude: cli, cwd: root }))
    if (descriptor.mode !== 'subscription') throw new Error('CLI smoke requires a confirmed subscription route; found ' + descriptor.mode + '. No model call made.')
    const runner = await new ClaudeRunner({ dir: path.join(root, 'runner') }).load()
    try {
      const session = await runner.create({ workspace: root, model: 'haiku', effort: 'low', args: abClaudeArgs({ writable: false, lean: true, instructions: 'Return only the requested handoff. Do not use tools or modify files.' }) })
      const done = new Promise((resolve) => runner.once('finished', resolve))
      runner.run(session.id, prompt)
      const event = await Promise.race([done, deadline])
      assert.equal(event.status, 'done', event.error)
      const result = parsePresetBrief(event.text, run)
      assert.equal(result.status, 'ready')
      console.log(JSON.stringify({ provider, model: 'haiku', effort: 'low', authMode: descriptor.mode, parsed: result.status, briefChars: result.brief.length, usage: event.usage }))
    } finally { await runner.shutdown() }
  } else {
    const descriptor = authDescriptor(await claudeAuthStatus({ claude: findClaude(), cwd: root }))
    assert.equal(descriptor.mode, 'subscription', 'No model call on an unconfirmed billing route')
    let manager
    const server = http.createServer((req, res) => {
      let data = ''; req.on('data', (chunk) => { data += chunk }); req.on('end', () => {
        const value = JSON.parse(data); manager.hook(value.id, value.secret, value.event); res.writeHead(204).end()
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    manager = await new TerminalManager({ file: path.join(root, 'terminals.json'), settingsFile: path.join(root, 'hooks.json'), hookUrl: () => 'http://127.0.0.1:' + server.address().port + '/hook', send() {} }).load()
    let marked = false
    const completed = new Promise((resolve, reject) => {
      manager.on('terminal', (terminal) => {
        if (terminal.state !== 'exited' || manager.closing) return
        reject(new Error('CLI exited with code ' + terminal.exitCode))
      })
      manager.on('hook', ({ input }) => {
      console.log('terminal hook: ' + input.hook_event_name)
      if (input.task_preset_marks?.includes(run.id)) marked = true
      if (['Stop', 'StopFailure'].includes(input.hook_event_name)) resolve(input)
      })
    })
    void completed.catch(() => {})
    try {
      const terminal = await manager.create({ workspace: root, model: 'haiku', effort: 'low', size: { cols: 120, rows: 40 } })
      const live = manager.live.get(terminal.id)
      live.term.onData((data) => live.proc.write(data))
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      let sent = false
      for (let attempt = 0; attempt < 90; attempt++) {
        await wait(500)
        const { dialog } = await manager.dialog(terminal.id).then((dialog) => ({ dialog }))
        if (dialog) {
          const trust = dialog.options.find((option) => /trust this (folder|project)/i.test(option.label))
          if (!trust) throw new Error('CLIの初期設定が必要です。通常のClaude Codeで初期設定を済ませてから再実行してください。モデルへの送信はしていません。')
          await manager.choose(terminal.id, trust.key, trust.label, dialog.dialogId)
          continue
        }
        const screen = Array.from({ length: live.term.buffer.active.length }, (_, row) => live.term.buffer.active.getLine(row)?.translateToString(true) ?? '').join(' ')
        if (screen.includes('Quick safety check') && screen.includes('Yes, I trust this folder') && screen.includes(root)) {
          // Consent is only for this disposable fixture created by this script, never a user workspace.
          console.log('confirming trust for the disposable fixture')
          live.proc.write(String.fromCharCode(27) + '[B' + String.fromCharCode(13))
          await wait(1000)
          continue
        }
        if (live.sessionAt !== null && manager.status(terminal.id).ready) { console.log('terminal ready; sending handoff'); await manager.sendMessage(terminal.id, prompt); sent = true; break }
      }
      assert.ok(sent, 'CLI never became ready')
      const hook = await Promise.race([completed, deadline])
      assert.equal(hook.hook_event_name, 'Stop')
      assert.ok(marked, 'submission marker missing')
      let turn
      for (const delay of [0, 100, 400, 1000]) { if (delay) await wait(delay); turn = (await manager.conversation(terminal.id)).turns.at(-1); if (turn?.status === 'done') break }
      assert.equal(turn?.status, 'done')
      assert.ok(matchesPresetPrompt(turn.user.text, prompt), 'normal terminal transcript must bind the exact prompt including an optional transport wrapper')
      const result = parsePresetBrief(turn.items.filter((item) => item.type === 'agent').at(-1)?.text, run)
      assert.equal(result.status, 'ready')
      console.log(JSON.stringify({ provider, model: 'haiku', effort: 'low', parsed: result.status, marker: marked, transcriptMatches: true, briefChars: result.brief.length }))
    } finally { await manager.shutdown(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  }
} finally {
  clearTimeout(timeout)
  // This is exactly the newly created disposable fixture, never a supplied path.
  assert.ok(path.basename(root).startsWith('preset-live-') && path.dirname(root) === os.tmpdir())
  await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
}
