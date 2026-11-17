import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TerminalManager } from '../server/terminals.js'
import { sendTerminalMessage } from '../web/src/terminal-send.ts'

function fakePty() {
  const spawned = []
  return {
    spawned,
    spawn(file, args, options) {
      const data = []
      const exits = []
      const proc = {
        file, args, options, written: [], killed: false, failWrite: null,
        onData: (fn) => data.push(fn),
        onExit: (fn) => exits.push(fn),
        write(text) {
          if (this.failWrite === text) {
            this.failWrite = null
            throw new Error('fake PTY write failed')
          }
          this.written.push(text)
          this.afterWrite?.(text)
        },
        resize() {},
        kill() {
          this.killed = true
          this.exit(0)
        },
        emit(text) { data.forEach((fn) => fn(text)) },
        exit(exitCode) { exits.forEach((fn) => fn({ exitCode })) },
      }
      spawned.push(proc)
      return proc
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('timed out waiting for the fake PTY')
    await sleep(5)
  }
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-terminal-send-'))
  const workspace = path.join(dir, 'project')
  await fs.mkdir(workspace)
  const pty = fakePty()
  const manager = await new TerminalManager({
    file: path.join(dir, 'terminals.json'),
    settingsFile: path.join(dir, 'settings.json'),
    hookUrl: () => 'http://127.0.0.1:47130/api/terminal-hook',
    send: () => {},
    pty,
    findClaude: () => 'fake-claude',
    preflight: async () => null,
    claudeHome: path.join(dir, 'claude'),
  }).load()
  t.after(async () => {
    await manager.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { dir, workspace, pty, manager }
}

async function createReady(manager, workspace) {
  const terminal = await manager.create({ workspace })
  manager.live.get(terminal.id).sessionAt = Date.now() - 5000
  return terminal
}

test('a new team leader waits for explicit folder trust without losing its chat draft', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const terminal = await manager.create({ workspace, team: { id: 'team', role: 'leader' }, size: { cols: 48, rows: 20 } })
  const proc = pty.spawned[0]
  const client = {}
  const live = manager.live.get(terminal.id)
  const states = []
  manager.on('terminal', (next) => states.push(next.workspaceTrustRequired ?? false))
  let draft = '最初の依頼'
  const failures = []
  const sending = sendTerminalMessage({
    send: (text) => manager.sendMessage(terminal.id, text),
    read: () => draft,
    clear: () => { draft = '' },
    fail: (message) => failures.push(message),
  }, draft)
  proc.emit('Quick safety check: Is this a project you created or one you trust?\r\n\r\n❯ No, exit\r\n  Yes, I trust ')
  proc.emit('this folder\r\n\r\nEnter to confirm · Esc to cancel')
  await until(() => states.at(-1) === true)
  live.startedAt -= 20_000 // The startup fallback must not treat the trust dialog as a composer.
  assert.equal(manager.status(terminal.id).ready, false)
  assert.equal(await sending, false)
  assert.equal(draft, '最初の依頼')
  assert.match(failures[0], /信頼確認/)
  await assert.rejects(manager.insertPath(terminal.id, 'attachment.png'), /信頼確認/)
  manager.pressEnter(terminal.id)
  assert.deepEqual(proc.written, [])

  // Only the user's explicit keys go through to Claude Code's own dialog.
  assert.equal(manager.input(terminal.id, client, '\x1b[B'), true)
  assert.equal(manager.input(terminal.id, client, '\r'), true)
  assert.deepEqual(proc.written, ['\x1b[B', '\r'])
  manager.hook(terminal.id, proc.options.env.AGENT_DESK_TERMINAL_SECRET, { hook_event_name: 'SessionStart', session_id: terminal.sessionId })
  assert.deepEqual(states, [true, false])
  live.sessionAt = Date.now() - 5000
  live.activity = 'running'
  await manager.sendMessage(terminal.id, draft)
  assert.deepEqual(proc.written, ['\x1b[B', '\r', draft, '\r'])
})

test('a declined folder remains actionable after exit and can restart in the same task', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const terminal = await manager.create({ workspace })
  const proc = pty.spawned[0]
  proc.emit("Claude Code didn't start because this folder isn't trusted.\r\n")
  proc.exit(1)
  const { terminal: exited } = await manager.attach(terminal.id, {}, { cols: 100, rows: 30 })
  assert.equal(exited.state, 'exited')
  assert.equal(exited.workspaceTrustRequired, true)
  const restarted = await manager.restart(terminal.id)
  assert.equal(restarted.state, 'running')
  assert.equal(restarted.id, terminal.id)
  assert.equal(restarted.workspaceTrustRequired, undefined)
})

test('concurrent sends to one terminal serialize bodies and retries after each Enter', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const terminal = await createReady(manager, workspace)
  const proc = pty.spawned[0]
  const live = manager.live.get(terminal.id)

  const first = manager.sendMessage(terminal.id, 'FIRST')
  const second = manager.sendMessage(terminal.id, 'SECOND')
  await until(() => proc.written.length > 0)
  assert.deepEqual(proc.written, ['FIRST'])
  await sleep(40)
  assert.deepEqual(proc.written, ['FIRST'])

  await first
  assert.deepEqual(proc.written, ['FIRST', '\r'])
  await until(() => proc.written.filter((value) => value === '\r').length === 3)
  await until(() => proc.written.includes('SECOND'))
  assert.deepEqual(proc.written.slice(0, 5), ['FIRST', '\r', '\r', '\r', 'SECOND'])

  // The second message gets its own Enter; it does not inherit the first send's retry.
  live.activity = 'running'
  await second
  assert.deepEqual(proc.written, ['FIRST', '\r', '\r', '\r', 'SECOND', '\r'])
})

test('a stop before Enter rejects delivery and keeps the message in the field', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const terminal = await createReady(manager, workspace)
  const proc = pty.spawned[0]
  let draft = '未送信の本文'
  const original = draft
  const failures = []
  const sending = sendTerminalMessage({
    send: (text) => manager.sendMessage(terminal.id, text),
    read: () => draft,
    clear: () => { draft = '' },
    fail: (message) => failures.push(message),
  }, original)

  await until(() => proc.written.includes(original))
  manager.stop(terminal.id)
  assert.equal(await sending, false)
  assert.equal(draft, '未送信の本文')
  assert.equal(failures.length, 1)
  assert.deepEqual(proc.written, ['未送信の本文'])
})

test('exit, replacement, and deletion reject a message before its Enter', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const cases = [], operations = []
  for (const action of ['exit', 'replace', 'remove']) {
    const terminal = await createReady(manager, workspace)
    const proc = manager.live.get(terminal.id).proc
    const text = 'pending-' + action
    // Trigger lifecycle changes in the PTY write itself, before sendMessage's
    // paste-to-Enter delay can elapse under a busy test runner.
    proc.afterWrite = (written) => {
      if (written !== text) return
      if (action === 'exit') proc.exit(1)
      else if (action === 'replace') {
        proc.exit(0)
        manager.restart(terminal.id)
      } else operations.push(manager.remove(terminal.id))
    }
    const send = manager.sendMessage(terminal.id, text)
    // A send may reject while another terminal is still being prepared or restarted.
    void send.catch(() => {})
    cases.push({ action, terminal, proc, text, send })
  }
  await until(() => cases.every(({ proc, text }) => proc.written.includes(text)))
  const results = await Promise.allSettled(cases.map(({ send }) => send))
  await Promise.all(operations)
  for (let i = 0; i < cases.length; i++) {
    assert.equal(results[i].status, 'rejected', cases[i].action)
    assert.deepEqual(cases[i].proc.written, [cases[i].text], cases[i].action)
  }
})

test('an Enter failure blocks later bodies on this live until restart', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const terminal = await createReady(manager, workspace)
  const proc = pty.spawned[0]
  let draft = 'first'
  const failures = []
  const field = {
    send: (text) => manager.sendMessage(terminal.id, text),
    read: () => draft,
    clear: () => { draft = '' },
    fail: (message) => failures.push(message),
  }

  const first = sendTerminalMessage(field, draft)
  await until(() => proc.written.includes('first'))
  proc.failWrite = '\r'
  assert.equal(await first, false)
  assert.equal(draft, 'first')
  assert.match(failures[0], /状態が不明/)

  draft = 'NEXT'
  assert.equal(await sendTerminalMessage(field, draft), false)
  assert.equal(draft, 'NEXT')
  assert.match(failures[1], /状態が不明/)
  assert.deepEqual(proc.written, ['first'])

  manager.stop(terminal.id)
  await manager.restart(terminal.id)
  const resumed = pty.spawned[1]
  const live = manager.live.get(terminal.id)
  live.sessionAt = Date.now() - 5000
  const afterRestart = sendTerminalMessage(field, draft)
  await until(() => resumed.written.includes('NEXT'))
  live.activity = 'running'
  assert.equal(await afterRestart, true)
  assert.equal(draft, '')
  assert.deepEqual(resumed.written, ['NEXT', '\r'])
})

test('an execution guard failure before paste does not poison the send queue', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const terminal = await createReady(manager, workspace)
  const proc = pty.spawned[0]
  let rejectOnce = true
  manager.executionGuard = () => {
    if (rejectOnce) {
      rejectOnce = false
      throw new Error('execution guard rejected')
    }
  }

  await assert.rejects(manager.sendMessage(terminal.id, 'BLOCKED'), /execution guard/)
  assert.deepEqual(proc.written, [])

  const live = manager.live.get(terminal.id)
  const next = manager.sendMessage(terminal.id, 'NEXT')
  await until(() => proc.written.includes('NEXT'))
  live.activity = 'running'
  await next
  assert.deepEqual(proc.written, ['NEXT', '\r'])
})

test('sends for different terminals run concurrently', async (t) => {
  const { workspace, pty, manager } = await setup(t)
  const one = await createReady(manager, workspace)
  const two = await createReady(manager, workspace)
  const first = manager.sendMessage(one.id, 'ONE')
  const second = manager.sendMessage(two.id, 'TWO')
  const [procOne, procTwo] = pty.spawned

  await until(() => procOne.written.includes('ONE') && procTwo.written.includes('TWO'))
  assert.deepEqual(procOne.written, ['ONE'])
  assert.deepEqual(procTwo.written, ['TWO'])
  manager.live.get(one.id).activity = 'running'
  manager.live.get(two.id).activity = 'running'
  await Promise.all([first, second])
  assert.deepEqual(procOne.written, ['ONE', '\r'])
  assert.deepEqual(procTwo.written, ['TWO', '\r'])
})
