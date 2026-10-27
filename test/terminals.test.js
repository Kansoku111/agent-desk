import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  API_KEY_ENV, DEFAULT_TITLE, REDRAW_DELAY_MS, TerminalManager, cleanTitle, findClaude, hookEffect, hookSettings, launchCommand,
  parseDialog, teamHookSettings, unroutedAgents,
} from '../server/terminals.js'

/** A stand-in for node-pty that records what the manager does with each process. */
function fakePty() {
  const spawned = []
  return {
    spawned,
    spawn(file, args, options) {
      const data = []
      const exits = []
      const proc = {
        file, args, options, written: [], killed: false, size: { cols: options.cols, rows: options.rows },
        onData: (fn) => data.push(fn),
        onExit: (fn) => exits.push(fn),
        write: (text) => proc.written.push(text),
        resize: (cols, rows) => {
          proc.size = { cols, rows }
        },
        kill: () => {
          proc.killed = true
          proc.exit(0)
        },
        emit: (text) => data.forEach((fn) => fn(text)),
        exit: (exitCode) => exits.forEach((fn) => fn({ exitCode })),
      }
      spawned.push(proc)
      return proc
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function setup({ launch, preflight = () => null, instructions, gptSubagent } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-terminals-'))
  const workspace = path.join(dir, 'project')
  const claudeHome = path.join(dir, 'claude')
  await fs.mkdir(workspace)
  const pty = fakePty()
  const sent = []
  const manager = await new TerminalManager({
    file: path.join(dir, 'terminals.json'),
    settingsFile: path.join(dir, 'claude-terminal-settings.json'),
    hookUrl: () => 'http://127.0.0.1:47130/api/terminal-hook',
    send: (client, frame) => sent.push({ client, frame }),
    pty,
    findClaude: () => 'C:\\Tools\\claude.exe',
    claudeHome,
    launch, preflight, instructions, gptSubagent,
  }).load()
  return { dir, workspace, claudeHome, pty, sent, manager }
}

test('interactive Claude parent scores on Stop without a viewer and freezes rates across restart', async (t) => {
  const { manager, workspace, dir, claudeHome } = await setup()
  t.after(() => manager.shutdown())
  const terminal = await manager.create({ workspace })
  const transcript = path.join(dir, 'parent.jsonl')
  const record = manager.records.get(terminal.id)
  record.transcriptPath = transcript
  const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
  manager.transcripts.pricing = async () => new Map([['anthropic/test-model', rates]])
  const entries = (id) => [
    { parentUuid: null, type: 'user', uuid: `u${id}`, message: { content: 'question' } },
    { parentUuid: `u${id}`, type: 'assistant', uuid: `a${id}`, message: { id: `m${id}`, model: 'test-model', content: [{ type: 'text', text: 'answer' }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 1000 } } },
    { type: 'system', subtype: 'turn_duration' },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  await fs.writeFile(transcript, entries(1))
  assert.equal(manager.hook(terminal.id, manager.live.get(terminal.id).secret, { hook_event_name: 'Stop' }), true)
  await Promise.all([...manager.usageReads])
  assert.ok(Math.abs(manager.summary(record).score.points - 1.55) < 1e-9)
  await manager.writes
  const restored = await new TerminalManager({ file: path.join(dir, 'terminals.json'), settingsFile: path.join(dir, 'claude-terminal-settings.json'),
    hookUrl: () => '', send: () => {}, claudeHome }).load()
  t.after(() => restored.shutdown())
  restored.transcripts.pricing = async () => new Map([['anthropic/test-model', { ...rates, output: 100 }]])
  const before = await restored.conversation(terminal.id)
  assert.ok(Math.abs(before.turns[0].totalScore.points - 1.55) < 1e-9)
  await fs.appendFile(transcript, entries(2))
  await restored.conversation(terminal.id)
  assert.ok(Math.abs(restored.summary(restored.records.get(terminal.id)).score.points - 7.6) < 1e-9)
  await restored.conversation(terminal.id)
  assert.ok(Math.abs(restored.summary(restored.records.get(terminal.id)).score.points - 7.6) < 1e-9)
})

test('findClaude searches PATH, then the installers\' folders', () => {
  const found = new Set(['C:\\bin\\claude.cmd', 'C:\\Users\\me\\.local\\bin\\claude.exe'])
  const exists = (file) => found.has(file)
  assert.equal(findClaude({ env: { PATH: 'C:\\empty;C:\\bin' }, platform: 'win32', home: 'C:\\Users\\me', exists }), 'C:\\bin\\claude.cmd')
  assert.equal(findClaude({ env: { Path: 'C:\\empty' }, platform: 'win32', home: 'C:\\Users\\me', exists }), 'C:\\Users\\me\\.local\\bin\\claude.exe')
  assert.equal(findClaude({ env: { PATH: '/usr/bin' }, platform: 'linux', home: '/home/me', exists: (file) => file === '/home/me/.local/bin/claude' }), '/home/me/.local/bin/claude')
  assert.equal(findClaude({ env: {}, platform: 'win32', home: 'C:\\Users\\me', exists: () => false }), null)
})

test('launchCommand runs an npm .cmd shim\'s script under node', () => {
  const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  assert.deepEqual(
    launchCommand('C:\\npm\\claude.cmd', ['--x'], { platform: 'win32', exists: (file) => file === script, node: 'C:\\node.exe' }),
    { file: 'C:\\node.exe', args: [script, '--x'] },
  )
  assert.deepEqual(launchCommand('C:\\bin\\claude.exe', ['--x'], { platform: 'win32' }), { file: 'C:\\bin\\claude.exe', args: ['--x'] })
})

test('cleanTitle drops the spinner and Claude Code\'s default title', () => {
  assert.equal(cleanTitle('✳ Fix the login bug'), 'Fix the login bug')
  assert.equal(cleanTitle('⠂ ログインを直す'), 'ログインを直す')
  assert.equal(cleanTitle('✳ Claude Code'), '')
  assert.equal(cleanTitle('claude'), '')
  assert.equal(cleanTitle('C:\\Users\\me\\.local\\bin\\claude.exe'), '')
  assert.equal(cleanTitle('/usr/local/bin/claude'), '')
})

test('hookSettings runs the hook script for each event, with forward slashes', () => {
  const settings = hookSettings('C:\\Program Files\\nodejs\\node.exe', 'F:\\app\\server\\claude-hook.js')
  assert.deepEqual(Object.keys(settings.hooks), [
    'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PostModelSwitch', 'SubagentStart', 'SubagentStop',
  ])
  const [command] = settings.hooks.Stop[0].hooks
  assert.equal(command.command, '"C:/Program Files/nodejs/node.exe" "F:/app/server/claude-hook.js"')
  assert.equal(command.async, false)
  for (const event of ['SubagentStart', 'SubagentStop', 'Notification']) assert.equal(settings.hooks[event][0].hooks[0].async, false)
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].async, true)
})

test('a task cannot start the user\'s agents whose model only a proxy routes', async () => {
  const { workspace, claudeHome, pty, manager, dir } = await setup()
  const agents = path.join(claudeHome, 'agents')
  await fs.mkdir(agents, { recursive: true })
  await fs.writeFile(path.join(agents, 'ocx-gpt-5-5.md'), '---\nname: "ocx-gpt-5-5"\ndescription: "gpt-5.5"\nmodel: "claude-ocx-native--gpt-5.5"\n---\n\nbody\n')
  await fs.writeFile(path.join(agents, 'reviewer.md'), '---\nname: reviewer\nmodel: sonnet\n---\n')
  await manager.create({ workspace })
  await settle()
  assert.equal(pty.spawned.length, 1)
  const settings = JSON.parse(await fs.readFile(path.join(dir, 'claude-terminal-settings.json'), 'utf8'))
  assert.deepEqual(settings.permissions, { deny: ['Agent(ocx-gpt-5-5)'] })
  assert.ok(settings.hooks.Stop)
  // Behind a proxy (ANTHROPIC_BASE_URL) the route can work, so they stay.
  assert.deepEqual(unroutedAgents(claudeHome, { ANTHROPIC_BASE_URL: 'http://localhost:10100' }), [])
  assert.deepEqual(unroutedAgents(path.join(dir, 'missing'), {}), [])
})

test('a task gets subagent_gpt on the chosen GPT model; a team\'s leader does not', async () => {
  let gpt = { model: 'gpt-6.1-sol', home: 'C:\\AgentDesk' }
  const { workspace, pty, manager, dir } = await setup({ gptSubagent: () => gpt, launch: () => ({ args: [] }) })
  const terminal = await manager.create({ workspace })
  const file = path.join(dir, 'claude-gpt-subagent', `${terminal.id}.json`)
  const args = pty.spawned[0].args
  assert.deepEqual(args.slice(-4), ['--mcp-config', file, '--settings', path.join(dir, 'claude-terminal-settings.json')])
  const server = JSON.parse(await fs.readFile(file, 'utf8')).mcpServers['agent-desk-gpt']
  assert.ok(server.args[0].endsWith('gpt-subagent-mcp.js'))
  assert.deepEqual(server.args.slice(1), ['--workspace', workspace, '--name', 'gpt-6.1-sol'])
  assert.deepEqual(server.env, { AGENT_DESK_HOME: 'C:\\AgentDesk' })
  await manager.create({ workspace, team: { id: 'team-1', role: 'leader' } })
  assert.ok(!pty.spawned[1].args.includes('--mcp-config'))
  gpt = null
  await manager.create({ workspace })
  assert.ok(!pty.spawned[2].args.includes('--mcp-config'))
  await manager.remove(terminal.id)
  await assert.rejects(fs.stat(file))
})

test('hookEffect follows a turn: prompt, approval, tool, stop', () => {
  assert.deepEqual(hookEffect({ hook_event_name: 'UserPromptSubmit' }, 'idle'), { activity: 'running', touched: true })
  assert.equal(hookEffect({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, 'running').activity, 'approval')
  assert.equal(hookEffect({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 'idle').activity, 'idle')
  assert.equal(hookEffect({ hook_event_name: 'PostToolUse' }, 'approval').activity, 'running')
  assert.deepEqual(hookEffect({ hook_event_name: 'Stop' }, 'running'), { activity: 'idle', touched: true, finished: true })
  assert.equal(hookEffect({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'x' }, 'running').activity, 'running')
})

test('a task starts claude with its session id and the hooks, without a parent Claude\'s markers', async () => {
  const { workspace, pty, manager, dir } = await setup()
  process.env.CLAUDECODE = '1'
  try {
    const terminal = await manager.create({ workspace, size: { cols: 90, rows: 20 } })
    const [proc] = pty.spawned
    assert.equal(proc.file, 'C:\\Tools\\claude.exe')
    assert.deepEqual(proc.args, ['--session-id', terminal.sessionId, '--settings', path.join(dir, 'claude-terminal-settings.json')])
    assert.equal(proc.options.cwd, workspace)
    assert.deepEqual(proc.size, { cols: 90, rows: 20 })
    assert.equal(proc.options.env.CLAUDECODE, undefined)
    assert.equal(proc.options.env.AGENT_DESK_TERMINAL_ID, terminal.id)
    // A request stuck on a stale connection is sent again well before Claude Code's own 180 s.
    assert.equal(proc.options.env.CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS, '30000')
    assert.equal(terminal.title, DEFAULT_TITLE)
    assert.equal(terminal.state, 'running')
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'terminals.json'), 'utf8'))
    assert.equal(saved.terminals[0].id, terminal.id)
  } finally {
    delete process.env.CLAUDECODE
  }
})

test('a viewer gets the screen so far, then the live output', async () => {
  const { workspace, pty, manager, sent } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  proc.emit('\x1b[?1006hhello\r\n')
  const viewer = { name: 'pc' }
  const { snapshot } = await manager.attach(terminal.id, viewer, { cols: 100, rows: 30 })
  assert.match(snapshot, /hello/)
  // The SGR mouse encoding is not part of xterm's serialized modes.
  assert.match(snapshot, /\x1b\[\?1006h/)
  proc.emit('world')
  await settle()
  assert.deepEqual(sent.filter((entry) => entry.frame.event === 'termData').map((entry) => [entry.client, entry.frame.data]), [[viewer, 'world']])
  manager.detach(terminal.id, viewer)
  proc.emit('more')
  await settle()
  assert.equal(sent.filter((entry) => entry.frame.event === 'termData').length, 1)
})

test('the viewer that types last sizes the terminal; only it answers queries', async () => {
  const { workspace, pty, manager, sent } = await setup()
  const terminal = await manager.create({ workspace, size: { cols: 120, rows: 40 } })
  const [proc] = pty.spawned
  const pc = { name: 'pc' }
  const phone = { name: 'phone' }
  await manager.attach(terminal.id, pc, { cols: 120, rows: 40 })
  await manager.attach(terminal.id, phone, { cols: 44, rows: 30 })
  assert.deepEqual(proc.size, { cols: 44, rows: 30 })
  assert.ok(sent.some((entry) => entry.client === pc && entry.frame.event === 'termSize' && entry.frame.size.cols === 44))

  // The PC's terminal answering a query while the phone is in control is dropped.
  assert.equal(manager.input(terminal.id, pc, '\x1b[?1;2c', true), false)
  assert.equal(manager.input(terminal.id, phone, '\x1b[?1;2c', true), true)
  // A size from the screen not in control is kept, not applied.
  manager.resize(terminal.id, pc, { cols: 110, rows: 36 }, false)
  assert.deepEqual(proc.size, { cols: 44, rows: 30 })
  // Typing on the PC takes control back, at the PC's latest size.
  assert.equal(manager.input(terminal.id, pc, 'a'), true)
  assert.deepEqual(proc.size, { cols: 110, rows: 36 })
  assert.deepEqual(proc.written, ['\x1b[?1;2c', 'a'])
  // Once the resizes stop, Claude Code is asked once to draw the screen again (Ctrl+L).
  await new Promise((resolve) => setTimeout(resolve, REDRAW_DELAY_MS + 50))
  assert.deepEqual(proc.written, ['\x1b[?1;2c', 'a', '\x0c'])
})

test('hooks report the session and activity, only with the process\'s secret', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  const secret = proc.options.env.AGENT_DESK_TERMINAL_SECRET
  const events = []
  manager.on('turn-finished', (info) => events.push(['finished', info.terminalId]))
  manager.on('approval-needed', (info) => events.push(['approval', info.terminalId]))

  assert.equal(manager.hook(terminal.id, 'wrong', { hook_event_name: 'UserPromptSubmit' }), false)
  const session = '0b8e4c1e-5d1a-4b5c-9a43-2f8f5f0c1a11'
  assert.equal(manager.hook(terminal.id, secret, { hook_event_name: 'SessionStart', source: 'clear', session_id: session, transcript_path: 'x.jsonl' }), true)
  manager.hook(terminal.id, secret, { hook_event_name: 'UserPromptSubmit' })
  assert.equal(manager.busy, true)
  manager.hook(terminal.id, secret, { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
  assert.equal(manager.summary(manager.records.get(terminal.id)).activity, 'approval')
  manager.hook(terminal.id, secret, { hook_event_name: 'Stop' })
  assert.equal(manager.busy, false)
  assert.equal(manager.records.get(terminal.id).sessionId, session)
  assert.deepEqual(events, [['approval', terminal.id], ['finished', terminal.id]])
})

test('Claude Code names the task through its terminal title until the user renames it', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  proc.emit('\x1b]0;✳ Add dark mode\x07')
  await settle()
  assert.equal(manager.records.get(terminal.id).title, 'Add dark mode')
  await manager.update(terminal.id, { title: 'My name' })
  proc.emit('\x1b]0;✳ Something else\x07')
  await settle()
  assert.equal(manager.records.get(terminal.id).title, 'My name')
})

test('a task resumes its saved conversation after the app restarts or Claude exits', async () => {
  const { workspace, pty, manager, claudeHome, dir } = await setup()
  const terminal = await manager.create({ workspace })
  pty.spawned[0].exit(0)
  await settle()
  assert.equal(manager.summary(manager.records.get(terminal.id)).state, 'exited')

  // Claude Code saved the conversation: the restart resumes it.
  await fs.mkdir(path.join(claudeHome, 'projects', 'some-project'), { recursive: true })
  await fs.writeFile(path.join(claudeHome, 'projects', 'some-project', `${terminal.sessionId}.jsonl`), '{}\n')
  manager.restart(terminal.id, null, { cols: 80, rows: 24 })
  assert.deepEqual(pty.spawned[1].args.slice(0, 2), ['--resume', terminal.sessionId])

  // A new app instance knows the task but has no process: opening it starts one.
  await manager.shutdown()
  const next = await new TerminalManager({
    file: path.join(dir, 'terminals.json'),
    settingsFile: path.join(dir, 'claude-terminal-settings.json'),
    hookUrl: () => 'http://127.0.0.1:1/api/terminal-hook',
    send: () => {},
    pty,
    findClaude: () => 'claude',
    claudeHome,
  }).load()
  assert.equal(next.list()[0].state, 'stopped')
  await next.attach(terminal.id, {}, { cols: 80, rows: 24 })
  assert.deepEqual(pty.spawned[2].args.slice(0, 2), ['--resume', terminal.sessionId])
})

test('hooks report the model and reasoning level Claude Code uses', () => {
  assert.equal(hookEffect({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' }, 'idle').model, 'claude-opus-5-5')
  assert.equal(hookEffect({ hook_event_name: 'PostModelSwitch', to_model: 'claude-haiku-5-5' }, 'idle').model, 'claude-haiku-5-5')
  assert.equal(hookEffect({ hook_event_name: 'Stop', effort: { level: 'xhigh' } }, 'running').effort, 'xhigh')
  assert.equal(hookEffect({ hook_event_name: 'Stop', effort: { level: 'nonsense' } }, 'running').effort, undefined)
})

test('a new model or level restarts an idle Claude Code on the same conversation, as session-only flags', async () => {
  const { workspace, pty, manager, claudeHome, dir } = await setup()
  const terminal = await manager.create({ workspace })
  assert.equal(pty.spawned[0].args.includes('--model'), false)
  const transcript = path.join(claudeHome, 'projects', 'p', `${terminal.sessionId}.jsonl`)
  await fs.mkdir(path.dirname(transcript), { recursive: true })
  await fs.writeFile(transcript, '{}\n')

  const viewer = {}
  const updated = await manager.configure(terminal.id, viewer, { model: 'claude-haiku-5-5' })
  assert.equal(pty.spawned[0].killed, true)
  assert.deepEqual(pty.spawned[1].args.slice(0, 4), ['--resume', terminal.sessionId, '--model', 'claude-haiku-5-5'])
  assert.equal(updated.model, 'claude-haiku-5-5')
  assert.equal(updated.state, 'running')

  // Leaving one out keeps it; null goes back to Claude Code's own default.
  await manager.configure(terminal.id, viewer, { effort: 'max' })
  assert.deepEqual(pty.spawned[2].args.slice(2, 6), ['--model', 'claude-haiku-5-5', '--effort', 'max'])
  await manager.configure(terminal.id, viewer, { model: null })
  assert.deepEqual(pty.spawned[3].args.slice(2, 4), ['--effort', 'max'])

  // The last choice is what a new task starts with.
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'terminals.json'), 'utf8'))
  assert.deepEqual(saved.defaults, { model: null, effort: 'max' })
  const next = await manager.create({ workspace })
  assert.equal(next.effort, 'max')
})

test('the model is not changed while Claude Code works, and odd values are refused', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const secret = pty.spawned[0].options.env.AGENT_DESK_TERMINAL_SECRET
  await assert.rejects(manager.configure(terminal.id, {}, { model: 'opus; rm -rf' }), /指定できません/)
  await assert.rejects(manager.configure(terminal.id, {}, { effort: 'ultra' }), /指定できません/)
  manager.hook(terminal.id, secret, { hook_event_name: 'UserPromptSubmit' })
  await assert.rejects(manager.configure(terminal.id, {}, { model: 'opus' }), /作業中/)
  assert.equal(pty.spawned.length, 1)
})

test('hookEffect reads the background work a turn leaves behind', () => {
  const task = (id, status = 'running', type = 'subagent') => ({ id, type, status, description: 'x' })
  assert.deepEqual(hookEffect({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, 'running').background, { started: 'a1', label: 'Explore' })
  assert.deepEqual(hookEffect({ hook_event_name: 'SubagentStop', agent_id: 'a1' }, 'idle').background, { stopped: 'a1' })
  // Registry ids for subagents are not lifecycle agent ids; do not count them twice.
  const stop = hookEffect({ hook_event_name: 'Stop', background_tasks: [task('a1'), task('b2', 'completed'), task('c3', 'running', 'shell')] }, 'running')
  assert.deepEqual(stop.background, { running: [{ id: 'c3', label: 'x' }] })
  assert.equal(stop.activity, 'idle')
  // An older Claude Code sends no list: nothing is known, so nothing changes.
  assert.equal(hookEffect({ hook_event_name: 'Stop' }, 'running').background, undefined)
  assert.equal(hookEffect({ hook_event_name: 'SubagentStart' }, 'running').background, undefined)
})

test('a turn that ended with agents still working in the background keeps the task busy and its model fixed', async () => {
  const { workspace, pty, manager, claudeHome } = await setup()
  const terminal = await manager.create({ workspace })
  const secret = pty.spawned[0].options.env.AGENT_DESK_TERMINAL_SECRET
  const transcript = path.join(claudeHome, 'projects', 'p', `${terminal.sessionId}.jsonl`)
  await fs.mkdir(path.dirname(transcript), { recursive: true })
  await fs.writeFile(transcript, '{}\n')
  const hook = (event) => manager.hook(terminal.id, secret, event)
  const summary = () => manager.summary(manager.records.get(terminal.id))
  const changes = []
  manager.on('terminal', (info) => changes.push(info.background))

  hook({ hook_event_name: 'UserPromptSubmit' })
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
  hook({ hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] })
  // The turn is over, yet the app must not be replaced, and Claude Code must not be started again.
  assert.equal(summary().activity, 'idle')
  assert.equal(summary().background, 1)
  assert.equal(manager.busy, true)
  await assert.rejects(manager.configure(terminal.id, {}, { model: 'opus' }), /裏で/)
  assert.equal(pty.spawned.length, 1)
  assert.equal(pty.spawned[0].killed, false)

  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
  assert.equal(summary().background, 0)
  assert.equal(manager.busy, false)
  // A Stop report that was sent before the agent ended can arrive after it: the agent stays ended.
  hook({ hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] })
  assert.equal(summary().background, 0)
  assert.equal(manager.busy, false)
  assert.deepEqual(changes.filter((count, index) => count !== changes[index - 1]), [0, 1, 0])

  // A resumed agent keeps its id and counts again.
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
  assert.equal(summary().background, 1)
  hook({ hook_event_name: 'Stop', background_tasks: [] })
  assert.equal(summary().background, 1)
  assert.equal(manager.busy, true)
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
  assert.equal(summary().background, 0)

  // With nothing left, the model changes as before; the new process starts with no background work.
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a2' })
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a2' })
  await manager.configure(terminal.id, {}, { model: 'opus' })
  assert.equal(pty.spawned.length, 2)
  assert.equal(manager.summary(manager.records.get(terminal.id)).background, 0)
})

test('registry snapshots reconcile non-agent work without duplicating or completing lifecycle agents', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const secret = pty.spawned[0].options.env.AGENT_DESK_TERMINAL_SECRET
  const hook = (event) => manager.hook(terminal.id, secret, event)
  const count = () => manager.summary(manager.records.get(terminal.id)).background
  hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1' })
  hook({ hook_event_name: 'Stop', background_tasks: [
    { id: 'different-task-id', type: 'subagent', status: 'running' },
    { id: 'shell-1', type: 'shell', status: 'running' },
  ] })
  assert.equal(count(), 2)
  // A task-list item completing is not evidence that its agent stopped.
  hook({ hook_event_name: 'TaskCompleted', task_id: 'agent-1', agent_id: 'agent-1' })
  assert.equal(count(), 2)
  // Older versions omit snapshots; do not infer completion.
  hook({ hook_event_name: 'Stop' })
  assert.equal(count(), 2)
  // The final agent stop carries a fresh parent snapshot, even without another Stop.
  hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', background_tasks: [] })
  assert.equal(count(), 0)
  assert.equal(manager.busy, false)
})

test('only supported workers with an explicit active status count in registry snapshots', () => {
  const tasks = [
    { id: 'hook', type: 'hook', status: 'running' },
    { id: 'unknown', type: 'future-internal-type', status: 'running' },
    { id: 'missing', type: 'shell' },
    { id: 'odd', type: 'shell', status: 'unknown' },
    { id: 'finished', type: 'shell', status: 'completed' },
    { id: 'failed', type: 'shell', status: 'failed' },
    { id: '', type: 'shell', status: 'running' },
    { id: 'shell', type: 'shell', status: 'running' },
    { id: 'mcp', type: 'MCP task', status: 'running' },
  ]
  assert.deepEqual(hookEffect({ hook_event_name: 'Stop', background_tasks: tasks }, 'running').background,
    { running: [{ id: 'shell', label: 'shell' }, { id: 'mcp', label: 'MCP task' }] })
})

test('the task lists what runs in the background, keeping when each one started', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const secret = pty.spawned[0].options.env.AGENT_DESK_TERMINAL_SECRET
  const hook = (event) => manager.hook(terminal.id, secret, event)
  const work = () => manager.summary(manager.records.get(terminal.id)).backgroundWork
  const changes = []
  manager.on('terminal', (info) => changes.push(info.backgroundWork.map((entry) => entry.label)))
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' })
    hook({ hook_event_name: 'Stop', background_tasks: [{ id: 's1', type: 'shell', status: 'running', description: '', command: 'npm test' }] })
    const started = now
    assert.deepEqual(work(), [{ label: 'Explore', since: started }, { label: 'npm test', since: started }])
    now += 60_000
    hook({ hook_event_name: 'Stop', background_tasks: [
      { id: 's1', type: 'shell', status: 'running', command: 'npm test' },
      { id: 'w1', type: 'workflow', status: 'running', name: 'review' },
    ] })
    assert.deepEqual(work().map((entry) => entry.since), [started, started, now])
    // One task ending as another starts keeps the count, yet the list changed.
    hook({ hook_event_name: 'Stop', background_tasks: [
      { id: 's1', type: 'shell', status: 'running', command: 'npm test' },
      { id: 'm1', type: 'MCP task', status: 'running', server: 'gpt', tool: 'ask' },
    ] })
    assert.deepEqual(changes.at(-1), ['Explore', 'npm test', 'gpt ask'])
  } finally {
    Date.now = realNow
  }
})

test('idle notification repairs missed agent completion but never clears shell work', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const secret = pty.spawned[0].options.env.AGENT_DESK_TERMINAL_SECRET
  const hook = (event) => manager.hook(terminal.id, secret, event)
  const count = () => manager.summary(manager.records.get(terminal.id)).background
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
  hook({ hook_event_name: 'Stop', background_tasks: [{ id: 's1', type: 'shell', status: 'running' }] })
  hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
  assert.equal(count(), 2)
  // Hooks also fire inside children: a child's idle state says nothing about siblings.
  hook({ hook_event_name: 'SubagentStart', agent_id: 'sibling' })
  hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', agent_id: 'a1' })
  assert.equal(count(), 3)
  hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })
  assert.equal(count(), 1)
  assert.equal(manager.busy, true)
  // A resumed agent is still counted after the repair, even with the same id.
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
  assert.equal(count(), 2)
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', background_tasks: [] })
  assert.equal(count(), 0)
})

test('background work that never reported its end stops counting after a while', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const secret = pty.spawned[0].options.env.AGENT_DESK_TERMINAL_SECRET
  manager.hook(terminal.id, secret, { hook_event_name: 'SubagentStart', agent_id: 'a1' })
  assert.equal(manager.busy, true)
  const realNow = Date.now
  Date.now = () => realNow() + 7 * 60 * 60 * 1000
  try {
    assert.equal(manager.busy, false)
    assert.equal(manager.summary(manager.records.get(terminal.id)).background, 0)
  } finally {
    Date.now = realNow
  }
})

test('removing a task ends its process and forgets it', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const removed = []
  manager.on('removed', (info) => removed.push(info.terminalId))
  assert.deepEqual(await manager.remove(terminal.id), { removed: true })
  assert.equal(pty.spawned[0].killed, true)
  assert.deepEqual(manager.list(), [])
  assert.deepEqual(removed, [terminal.id])
})

test('a missing claude or folder is reported, and no task is left behind', async () => {
  const { workspace, manager } = await setup()
  manager.findClaude = () => null
  await assert.rejects(manager.create({ workspace }), /claude コマンド/)
  await assert.rejects(manager.create({ workspace: path.join(workspace, 'gone') }), /フォルダが見つかりません/)
  assert.deepEqual(manager.list(), [])
})

test('the conversation is read from the file Claude Code keeps, found by session id before any hook has named it', async () => {
  const { workspace, manager, claudeHome } = await setup()
  const terminal = await manager.create({ workspace })
  const before = await manager.conversation(terminal.id)
  assert.deepEqual(before.turns, [])
  assert.equal(before.file, null)
  await fs.mkdir(path.join(claudeHome, 'projects', 'some-project'), { recursive: true })
  const entry = { parentUuid: null, isSidechain: false, type: 'user', uuid: 'u1', timestamp: '2026-10-20T00:00:00Z', message: { role: 'user', content: 'こんにちは' } }
  const file = path.join(claudeHome, 'projects', 'some-project', `${terminal.sessionId}.jsonl`)
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`)
  const first = await manager.conversation(terminal.id)
  assert.deepEqual(first.turns.map((turn) => turn.user.text), ['こんにちは'])
  assert.equal(first.file, file)
  const again = await manager.conversation(terminal.id, { epoch: first.epoch, since: first.rev })
  assert.equal(again.turns.length, 0)
  await assert.rejects(manager.conversation('nope'), /見つかりません/)
})

test('a message sent without the screen is pasted into Claude Code, then Enter follows', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  // Claude Code reported its session a while ago: its input box is up.
  manager.live.get(terminal.id).sessionAt = Date.now() - 5000
  await manager.sendMessage(terminal.id, 'one\ntwo')
  assert.deepEqual(proc.written, ['one\ntwo', '\r'])
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(proc.written, ['one\ntwo', '\r'])
  // Claude Code stayed idle (the Enter was taken as part of the paste): Enter is pressed once more.
  await new Promise((resolve) => setTimeout(resolve, 1700))
  assert.deepEqual(proc.written, ['one\ntwo', '\r', '\r'])
  // The hook reports that Claude took the prompt; the pending retry must stop.
  manager.live.get(terminal.id).activity = 'running'

  // Claude Code asked for bracketed paste: the message goes inside it, so its line breaks stay in the message.
  proc.emit('\x1b[?2004h')
  await settle()
  proc.written.length = 0
  await manager.sendMessage(terminal.id, 'a\nb')
  assert.deepEqual(proc.written, ['\x1b[200~a\nb\x1b[201~', '\r'])
  await assert.rejects(manager.sendMessage('nope', 'x'), /動いていません/)
})

test('a message sent while Claude Code starts waits for its input box, which would drop it', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  const sent = manager.sendMessage(terminal.id, 'hello')
  const file = manager.insertPath(terminal.id, 'C:\\a.png')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(proc.written, [])
  manager.live.get(terminal.id).sessionAt = Date.now() - 5000
  await Promise.all([sent, file])
  assert.deepEqual(proc.written, ['hello', 'C:\\a.png ', '\r'])

  // Claude Code ended before its box came up: the sender hears it.
  const second = await manager.create({ workspace })
  const waiting = manager.sendMessage(second.id, 'x')
  pty.spawned[1].exit(1)
  await assert.rejects(waiting, /動いていません/)
})


test('a task starts with the custom instructions as an appended system prompt, read again at each start', async () => {
  let text = 'git操作はお任せします。'
  const { workspace, pty, manager, dir } = await setup({ instructions: () => text })
  const terminal = await manager.create({ workspace })
  const file = path.join(dir, 'claude-instructions.md')
  assert.deepEqual(pty.spawned[0].args, ['--session-id', terminal.sessionId, '--append-system-prompt-file', file, '--settings', path.join(dir, 'claude-terminal-settings.json')])
  assert.match(await fs.readFile(file, 'utf8'), /<user_instructions>\ngit操作はお任せします。\n<\/user_instructions>/)
  text = '日本語で答えること。'
  pty.spawned[0].exit(0)
  await settle()
  manager.restart(terminal.id, null, { cols: 80, rows: 24 })
  assert.match(await fs.readFile(file, 'utf8'), /日本語で答えること。/)
})

test('a task without custom instructions adds no prompt flag', async () => {
  const { workspace, pty, manager } = await setup({ instructions: () => '  ' })
  await manager.create({ workspace })
  assert.ok(!pty.spawned[0].args.includes('--append-system-prompt-file'))
})

test('a team task gets its own settings and flags, with the first prompt after the single-value --settings', async () => {
  const launches = []
  const { workspace, pty, manager, dir } = await setup({
    launch: (record) => {
      launches.push(record.team)
      return { args: ['--mcp-config', 'mcp.json', '--allowedTools', 'mcp__agent-team'] }
    },
  })
  const team = { id: 'team-1', role: 'leader' }
  const terminal = await manager.create({ workspace, team, model: 'opus', effort: null, prompt: 'Read the file: C:\\a b\\task.md' })
  const [proc] = pty.spawned
  assert.deepEqual(proc.args, [
    '--session-id', terminal.sessionId, '--model', 'opus', '--mcp-config', 'mcp.json', '--allowedTools', 'mcp__agent-team',
    '--settings', path.join(dir, 'claude-team-leader-settings.json'), 'Read the file: C:\\a b\\task.md',
  ])
  assert.deepEqual(launches, [team])
  assert.deepEqual(terminal.team, team)
  // Started on a prompt, it is working from the start, also through its SessionStart.
  assert.equal(terminal.activity, 'running')
  const secret = proc.options.env.AGENT_DESK_TERMINAL_SECRET
  manager.hook(terminal.id, secret, { hook_event_name: 'SessionStart', source: 'startup', session_id: terminal.sessionId })
  assert.equal(manager.status(terminal.id).activity, 'running')
  manager.hook(terminal.id, secret, { hook_event_name: 'Stop' })
  assert.equal(manager.status(terminal.id).activity, 'idle')
  // A task of its own keeps the plain flags and asks no launch.
  await manager.create({ workspace })
  assert.deepEqual(pty.spawned[1].args.slice(-2), ['--settings', path.join(dir, 'claude-terminal-settings.json')])
  assert.equal(launches.length, 1)
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'claude-team-leader-settings.json'), 'utf8'))
  assert.equal(saved.skipDangerousModePermissionPrompt, true)
  assert.ok(saved.hooks.StopFailure)
})

test('settle: a turn that ended without its Stop hook is read from the conversation file', async () => {
  const { workspace, pty, manager, dir } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  const secret = proc.options.env.AGENT_DESK_TERMINAL_SECRET
  const file = path.join(dir, 'transcript.jsonl')
  manager.hook(terminal.id, secret, { hook_event_name: 'SessionStart', session_id: terminal.sessionId, transcript_path: file })
  manager.hook(terminal.id, secret, { hook_event_name: 'UserPromptSubmit' })
  const line = (entry) => `${JSON.stringify(entry)}\n`
  await fs.writeFile(file, line({ parentUuid: null, type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }))
  // Still working: nothing changes.
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), false)
  assert.equal(manager.status(terminal.id).activity, 'running')
  await fs.appendFile(file, line({ parentUuid: 'u1', type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'done' }] } })
    + line({ type: 'system', subtype: 'turn_duration', parentUuid: 'a1', uuid: 's1', timestamp: new Date().toISOString() }))
  // Written just now: it waits for the file to be still.
  assert.equal(await manager.settle(terminal.id), false)
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), true)
  assert.equal(manager.status(terminal.id).activity, 'idle')
})

test('interrupt presses Esc, then marks the task idle once the conversation file shows the interruption', async () => {
  const { workspace, pty, manager, dir } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  const secret = proc.options.env.AGENT_DESK_TERMINAL_SECRET
  const file = path.join(dir, 'transcript.jsonl')
  manager.hook(terminal.id, secret, { hook_event_name: 'SessionStart', session_id: terminal.sessionId, transcript_path: file })
  manager.hook(terminal.id, secret, { hook_event_name: 'UserPromptSubmit' })
  const line = (entry) => `${JSON.stringify(entry)}\n`
  await fs.writeFile(file, line({ parentUuid: null, type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }))
  const written = []
  proc.write = (data) => written.push(data)
  assert.equal(manager.interrupt(terminal.id, 'viewer'), true)
  assert.deepEqual(written, ['\x1b'])
  // Claude Code runs no Stop hook for an interruption; it only records it.
  await fs.appendFile(file, line({ parentUuid: 'u1', type: 'user', uuid: 'u2', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))
  for (let tries = 0; tries < 20 && manager.status(terminal.id).activity !== 'idle'; tries++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(manager.status(terminal.id).activity, 'idle')
})

/** A task whose prompt Claude Code took (and wrote to the conversation file) but never answered. */
async function droppedTurn() {
  const harness = await setup()
  const { workspace, pty, manager, dir, claudeHome } = harness
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  const secret = proc.options.env.AGENT_DESK_TERMINAL_SECRET
  const file = path.join(dir, 'transcript.jsonl')
  manager.hook(terminal.id, secret, { hook_event_name: 'SessionStart', session_id: terminal.sessionId, transcript_path: file })
  manager.hook(terminal.id, secret, { hook_event_name: 'UserPromptSubmit' })
  await fs.writeFile(file, `${JSON.stringify({ parentUuid: null, type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n`)
  const live = manager.live.get(terminal.id)
  // The turn began a minute ago.
  live.runningAt = Date.now() - 60_000
  const sessions = path.join(claudeHome, 'sessions')
  await fs.mkdir(sessions, { recursive: true })
  /** Claude Code's session file for this task's process (`status`: what it reports; `at`: when it did). */
  const report = (status, at, extra = {}) => fs.writeFile(path.join(sessions, `${extra.pid ?? 4242}.json`), JSON.stringify({
    pid: 4242, sessionId: terminal.sessionId, startedAt: live.startedAt + 500, status, statusUpdatedAt: at, ...extra,
  }))
  return { ...harness, terminal, proc, report, now: Date.now() }
}

test('settle: a turn stopped before Claude Code answered is ended by its own idle report', async () => {
  const { manager, terminal, report } = await droppedTurn()
  // Working: the conversation file shows a turn without an answer and Claude Code says busy.
  await report('busy', Date.now() - 30_000)
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), false)
  assert.equal(manager.status(terminal.id).activity, 'running')
  // Idle since after the turn began, but only just: a Stop hook may still be on its way.
  await report('idle', Date.now() - 100)
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), false)
  assert.equal(manager.status(terminal.id).activity, 'running')
  await report('idle', Date.now() - 10_000)
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), true)
  assert.equal(manager.status(terminal.id).activity, 'idle')
})

test('settle: an idle report from before the turn, or of another session or process, does not end it', async () => {
  const { manager, terminal, report, claudeHome } = await droppedTurn()
  // Idle, but from before this turn began.
  await report('idle', Date.now() - 120_000)
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), false)
  // The file of an unrelated session (or of the process this one replaced) says idle.
  await report('idle', Date.now() - 10_000, { pid: 1, sessionId: 'someone-else' })
  await report('idle', Date.now() - 10_000, { pid: 2, startedAt: 1 })
  await fs.writeFile(path.join(claudeHome, 'sessions', 'broken.json'), '{ not json')
  assert.equal(await manager.settle(terminal.id, { quietMs: 0 }), false)
  assert.equal(manager.status(terminal.id).activity, 'running')
})

test('interrupt: a task whose turn is already over in Claude Code stops showing as working', async () => {
  const { manager, terminal, proc, report } = await droppedTurn()
  const written = []
  proc.write = (data) => written.push(data)
  await report('idle', Date.now() - 10_000)
  assert.equal(manager.interrupt(terminal.id, 'viewer'), true)
  assert.deepEqual(written, ['\x1b'])
  for (let tries = 0; tries < 20 && manager.status(terminal.id).activity !== 'idle'; tries++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(manager.status(terminal.id).activity, 'idle')
})

test('a team title stays as given; model and level are checked', async () => {
  const { workspace, manager } = await setup()
  const terminal = await manager.create({ workspace, title: 'A: 効果音', model: 'claude-haiku-5-5', effort: 'low' })
  assert.equal(terminal.title, 'A: 効果音')
  assert.equal(manager.records.get(terminal.id).renamed, true)
  await assert.rejects(manager.create({ workspace, model: 'bad model' }), /このモデル/)
  await assert.rejects(manager.create({ workspace, effort: 'turbo' }), /この推論レベル/)
})

test('teamHookSettings: an error ends a leader\'s turn too, and bypass mode starts without its dialog', () => {
  const leader = teamHookSettings('C:\\node.exe', 'F:\\app\\claude-hook.js')
  assert.equal(leader.hooks.StopFailure[0].hooks[0].command, '"C:/node.exe" "F:/app/claude-hook.js"')
  assert.equal(leader.hooks.PermissionRequest, undefined)
  assert.equal(leader.skipDangerousModePermissionPrompt, true)
  assert.deepEqual(hookEffect({ hook_event_name: 'StopFailure' }, 'running'), { activity: 'idle', touched: true, finished: true, failed: true })
})

test('status says when Claude Code takes typed input, and who typed last', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  assert.equal(manager.status(terminal.id).ready, false)
  manager.hook(terminal.id, proc.options.env.AGENT_DESK_TERMINAL_SECRET, { hook_event_name: 'SessionStart', session_id: terminal.sessionId })
  manager.live.get(terminal.id).sessionAt -= 5000
  assert.equal(manager.status(terminal.id).ready, true)
  manager.input(terminal.id, 'client', 'x')
  assert.ok(Date.now() - manager.status(terminal.id).inputAt < 1000)
  assert.equal(manager.status('nope'), null)
})

test('a confirmed team session inherits the same credential environment as an independent task', async () => {
  const { workspace, pty, manager } = await setup({ launch: () => ({ args: [] }) })
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test'
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-test'
  try {
    await manager.create({ workspace, team: { id: 'team-1', role: 'child', childId: 'c1' } })
    await manager.create({ workspace })
    const [team, own] = pty.spawned
    assert.equal(team.options.env.ANTHROPIC_API_KEY, 'sk-ant-api-test')
    assert.equal(team.options.env.ANTHROPIC_AUTH_TOKEN, 'token-test')
    // A task of the user's own keeps their environment as it is.
    assert.equal(own.options.env.ANTHROPIC_API_KEY, 'sk-ant-api-test')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
  }
})

test('team PTY create, restart, model restart and restored attach all check consent before spawn', async () => {
  let refusal = 'confirmation required'
  let checks = 0
  const { workspace, pty, manager } = await setup({ preflight: async () => { checks++; return refusal } })
  await assert.rejects(manager.create({ workspace, team: { id: 't' } }), /confirmation required/)
  assert.equal(pty.spawned.length, 0)
  refusal = null
  const terminal = await manager.create({ workspace, team: { id: 't' } })
  assert.equal(pty.spawned.length, 1)
  manager.stop(terminal.id)
  refusal = 'auth changed'
  await assert.rejects(manager.restart(terminal.id), /auth changed/)
  assert.equal(pty.spawned.length, 1)
  refusal = null
  await manager.restart(terminal.id)
  refusal = 'auth changed'
  await assert.rejects(manager.configure(terminal.id, null, { model: 'sonnet' }), /auth changed/)
  assert.equal(pty.spawned.length, 2)
  manager.live.delete(terminal.id)
  await assert.rejects(manager.attach(terminal.id, 'client'), /auth changed/)
  assert.equal(pty.spawned.length, 2)
  assert.equal(checks, 6)
  await manager.shutdown()
})

test('a report joining a pending prompt-less attach is retained in the single launch', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace, team: { id: 't' } })
  manager.stop(terminal.id)
  manager.live.delete(terminal.id)
  let release
  manager.preflight = () => new Promise((resolve) => { release = resolve })
  const attaching = manager.attach(terminal.id, 'viewer')
  assert.equal(manager.status(terminal.id).starting, true)
  const reporting = manager.restart(terminal.id, null, undefined, { prompt: 'report must survive' })
  release(null)
  await Promise.all([attaching, reporting])
  assert.equal(pty.spawned.length, 2)
  assert.equal(pty.spawned[1].args.at(-1), 'report must survive')
  await manager.shutdown()
})

test('pending team PTY inspection is deduplicated and stop cancels launch', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace, team: { id: 't' } })
  manager.stop(terminal.id)
  let release, checks = 0
  manager.preflight = () => { checks++; return new Promise((resolve) => { release = resolve }) }
  const first = manager.restart(terminal.id)
  const second = manager.restart(terminal.id)
  assert.equal(checks, 1)
  assert.equal(manager.busy, true)
  manager.stop(terminal.id)
  release(null)
  await assert.rejects(first, /キャンセル/)
  await assert.rejects(second, /キャンセル/)
  assert.equal(pty.spawned.length, 1)
  await manager.shutdown()
})

/** Claude Code 2.1's approval for a shell command, as its screen reads (captured from a real one). */
const APPROVAL_SCREEN = [
  '● Removing the specified nonexistent test directory',
  '  ⎿  $ rm -r ./test-dir',
  '',
  '─'.repeat(100),
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  ' Remove the specified nonexistent test directory',
  '╌'.repeat(100),
  ' rm -r ./test-dir',
  '╌'.repeat(100),
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to F:\\Agent-Desk-DSH from this project',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
]

test('parseDialog reads the choice Claude Code waits on off its screen', () => {
  const dialog = parseDialog(APPROVAL_SCREEN)
  assert.deepEqual(dialog.text, ['Bash command', 'Remove the specified nonexistent test directory', 'rm -r ./test-dir', 'Do you want to proceed?'])
  assert.deepEqual(dialog.options.map((option) => [option.key, option.label, option.selected]), [
    ['1', 'Yes', true],
    ['2', 'Yes, and always allow access to F:\\Agent-Desk-DSH from this project', false],
    ['3', 'Yes, and switch to auto mode · auto mode handles these prompts for you', false],
    ['4', 'No', false],
  ])
  // A question's entries can have a description under them.
  const question = parseDialog(['─'.repeat(40), ' どちらの形式にしますか？', '', ' ❯ 1. GLB', '      一つのファイルにまとめる', '   2. FBX', '      Blender 向け'])
  assert.deepEqual(question.text, ['どちらの形式にしますか？'])
  assert.deepEqual(question.options.map((option) => [option.label, option.detail]), [['GLB', '一つのファイルにまとめる'], ['FBX', 'Blender 向け']])
  // AskUserQuestion as Claude Code 2.1 draws it: a rule sets its last entry apart.
  const asked = parseDialog([
    '─'.repeat(100), ' ☐ 3D形式', '3Dフォーマットはどちらを優先しますか？', '❯ 1. GLB', '     単一バイナリで扱いやすい', '  2. FBX', '     DCC ツール向け',
    '  3. Type something.', '─'.repeat(100), '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ])
  assert.deepEqual(asked.text, ['☐ 3D形式', '3Dフォーマットはどちらを優先しますか？'])
  assert.deepEqual(asked.options.map((option) => option.label), ['GLB', 'FBX', 'Type something.', 'Chat about this'])
  assert.equal(asked.options[0].detail, '単一バイナリで扱いやすい')
  // A numbered list Claude wrote is not a choice.
  assert.equal(parseDialog(['● 手順:', '  1. ビルドする', '  2. テストする', '', '❯ ']), null)
})

test('the choice Claude Code waits on is answered from the chat view by its number', async () => {
  const { workspace, pty, manager } = await setup()
  const terminal = await manager.create({ workspace })
  const [proc] = pty.spawned
  const secret = proc.options.env.AGENT_DESK_TERMINAL_SECRET
  proc.emit(APPROVAL_SCREEN.join('\r\n'))
  // Not asked for anything yet.
  assert.equal(await manager.dialog(terminal.id), null)
  manager.hook(terminal.id, secret, { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
  const dialog = await manager.dialog(terminal.id)
  assert.equal(dialog.options.length, 4)
  await assert.rejects(manager.choose(terminal.id, '4', 'Yes'), /画面が変わりました/)
  assert.deepEqual(await manager.choose(terminal.id, '4', 'No'), { chosen: '4' })
  assert.equal(proc.written.at(-1), '4')
})
