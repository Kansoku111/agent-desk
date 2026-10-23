import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { ClaudeRunner, applyEvent } from '../server/claude-runner.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
/** Waits for the report of an ended run, which comes a few event-loop turns after the exit. */
const reported = async (finished) => {
  for (let tries = 0; tries < 200 && !finished.length; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
}

/** `claude -p` as a process: it reads its prompt on stdin and writes the events the test gives it. */
function fakeSpawn() {
  const spawned = []
  const spawn = (file, args, options) => {
    const proc = Object.assign(new EventEmitter(), {
      file, args, options, pid: 4000 + spawned.length, exitCode: null, killed: false, input: '',
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    })
    proc.stdin.on('data', (chunk) => { proc.input += chunk })
    proc.kill = () => {
      proc.killed = true
      proc.end(null)
    }
    proc.write = (event) => proc.stdout.write(`${JSON.stringify(event)}\n`)
    proc.end = (code = 0) => {
      proc.exitCode = code
      proc.stdout.end()
      proc.stderr.end()
      setImmediate(() => proc.emit('close', code))
    }
    spawned.push(proc)
    return proc
  }
  return { spawn, spawned }
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-runner-'))
  const { spawn, spawned } = fakeSpawn()
  const runner = await new ClaudeRunner({ dir, spawn, findClaude: () => '/usr/bin/claude', platform: 'linux' }).load()
  const finished = []
  runner.on('finished', (info) => finished.push(info))
  t.after(() => runner.shutdown())
  const done = () => new Promise((resolve) => runner.once('finished', resolve))
  return { dir, runner, spawned, finished, done }
}

const init = (apiKeySource = 'none') => ({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-5-5', apiKeySource })

test('a turn is one claude -p run: the prompt on stdin, its events folded into the turn, its result the reply', async (t) => {
  const { runner, spawned, finished, done } = await setup(t)
  const session = await runner.create({ workspace: '/work', model: 'haiku', effort: 'low', args: ['--append-system-prompt-file', 'child.md'] })
  assert.equal(runner.busy, false)
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test'
  try {
    runner.run(session.id, '効果音を作って')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }
  const [proc] = spawned
  assert.equal(proc.file, '/usr/bin/claude')
  assert.deepEqual(proc.args, [
    '--session-id', session.sessionId, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--permission-prompts', 'none', '--model', 'haiku', '--effort', 'low', '--append-system-prompt-file', 'child.md',
  ])
  assert.equal(proc.options.cwd, '/work')
  assert.equal(proc.options.env.ANTHROPIC_API_KEY, 'sk-ant-api-test')
  assert.equal(runner.get(session.id).state, 'running')
  assert.equal(runner.busy, true)
  await tick()
  assert.deepEqual(JSON.parse(proc.input), { type: 'user', message: { role: 'user', content: '効果音を作って' }, parent_tool_use_id: null, session_id: '' })
  // The input stays open while the turn runs, so a message can be added to it.
  assert.equal(proc.stdin.writableEnded, false)

  const ended = done()
  proc.write(init())
  proc.write({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '考える' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
  proc.write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.wav' }], is_error: false }] } })
  proc.write({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '作りました' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: '作りました', stop_reason: 'end_turn', permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'x' } }] })
  await tick()
  // The turn answered with nothing left to take: the input closes, and Claude Code exits.
  assert.equal(proc.stdin.writableEnded, true)
  proc.end(0)
  await ended
  assert.equal(runner.busy, false)
  assert.deepEqual(finished, [{ id: session.id, status: 'done', text: '作りました', error: null, denials: [{ tool_name: 'Write', tool_input: { file_path: 'x' } }] }])
  const [turn] = runner.turns(session.id)
  assert.equal(turn.status, 'done')
  assert.deepEqual(turn.items.map((item) => item.type), ['thought', 'tool', 'agent'])
  assert.equal(turn.items[1].output, 'a.wav')
  assert.equal(turn.items[1].status, 'completed')
  assert.equal(runner.get(session.id).modelInUse, 'claude-haiku-5-5')

  // The next turn resumes the same conversation.
  runner.run(session.id, '続けて')
  assert.deepEqual(spawned[1].args.slice(0, 2), ['--resume', session.sessionId])
  assert.throws(() => runner.run(session.id, 'もう一つ'), /作業中/)
})

const inputLines = (proc) => proc.input.trim().split('\n').map((line) => JSON.parse(line))
const replay = (uuid, content) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content } })

test('a message added to a running turn goes in on stdin and shows in the turn once Claude Code takes it', async (t) => {
  const { runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  assert.equal(runner.steer(session.id, 'no turn runs'), false)
  runner.run(session.id, '調べて')
  const [proc] = spawned
  await tick()
  assert.equal(runner.steer(session.id, '  '), false)
  assert.equal(runner.steer(session.id, 'ついでに音量も'), true)
  await tick()
  const [prompt, added] = inputLines(proc)
  assert.equal(prompt.message.content, '調べて')
  assert.equal(added.message.content, 'ついでに音量も')
  assert.match(added.uuid, /^[0-9a-f-]{36}$/)

  const ended = done()
  proc.write(init())
  proc.write({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] } })
  // The prompt's own replay is not a second message.
  proc.write(replay('someone-else', '調べて'))
  proc.write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } })
  proc.write(replay(added.uuid, 'ついでに音量も'))
  await tick()
  const [turn] = runner.turns(session.id)
  assert.deepEqual(turn.items.map((item) => item.type), ['tool', 'steer'])
  assert.equal(turn.items[1].text, 'ついでに音量も')
  assert.equal(turn.items[1].id, added.uuid)
  assert.equal(proc.stdin.writableEnded, false)

  proc.write({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '音量もそろえました' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: '音量もそろえました' })
  await tick()
  // Everything handed over was taken: the input closes, and no more can be added.
  assert.equal(proc.stdin.writableEnded, true)
  assert.equal(runner.steer(session.id, 'もう遅い'), false)
  proc.end(0)
  assert.equal((await ended).text, '音量もそろえました')
})

test('a message Claude Code has not taken when the turn answers keeps the input open for the turn it starts', async (t) => {
  const { runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, '短く答えて')
  const [proc] = spawned
  await tick()
  assert.equal(runner.steer(session.id, 'やっぱり英語で'), true)
  await tick()
  const [, added] = inputLines(proc)

  const ended = done()
  proc.write({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'はい' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'はい', permission_denials: [{ tool_name: 'Bash', tool_input: {} }] })
  await tick()
  assert.equal(proc.stdin.writableEnded, false)
  // Claude Code starts a turn of its own for the message.
  proc.write(init())
  proc.write(replay(added.uuid, 'やっぱり英語で'))
  proc.write({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Yes' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'Yes', permission_denials: [{ tool_name: 'Write', tool_input: {} }] })
  await tick()
  assert.equal(proc.stdin.writableEnded, true)
  proc.end(0)
  const info = await ended
  // One Agent Desk turn: the last answer is the reply, and what was denied along the way is kept.
  assert.equal(info.text, 'Yes')
  assert.deepEqual(info.denials.map((entry) => entry.tool_name), ['Bash', 'Write'])
  assert.deepEqual(runner.turns(session.id)[0].items.map((item) => item.type), ['agent', 'steer', 'agent'])
})

test('a message that is never taken is reported in the turn when the input closes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-runner-'))
  const { spawn, spawned } = fakeSpawn()
  const runner = await new ClaudeRunner({ dir, spawn, findClaude: () => '/usr/bin/claude', platform: 'linux', steerGraceMs: 20 }).load()
  t.after(() => runner.shutdown())
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  const [proc] = spawned
  await tick()
  runner.steer(session.id, '届かない指示')
  const ended = new Promise((resolve) => runner.once('finished', resolve))
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(proc.stdin.writableEnded, true)
  proc.end(0)
  await ended
  const notice = runner.turns(session.id)[0].items.at(-1)
  assert.equal(notice.type, 'notice')
  assert.equal(notice.level, 'warning')
  assert.match(notice.text, /届きませんでした: 届かない指示/)
})

test('a message added while the sign-in is still checked goes in behind the prompt', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-runner-'))
  const { spawn, spawned } = fakeSpawn()
  let release
  const preflight = () => new Promise((resolve) => { release = () => resolve(null) })
  const runner = await new ClaudeRunner({ dir, spawn, findClaude: () => '/usr/bin/claude', platform: 'linux', preflight }).load()
  t.after(() => runner.shutdown())
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, '最初')
  assert.equal(runner.steer(session.id, '二つ目'), true)
  assert.equal(spawned.length, 0)
  release()
  await tick()
  await tick()
  assert.deepEqual(inputLines(spawned[0]).map((line) => line.message.content), ['最初', '二つ目'])
})

test('API authentication is not rejected by the init event after preflight', async (t) => {
  const { runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  const ended = done()
  spawned[0].write(init('ANTHROPIC_API_KEY'))
  spawned[0].write({ type: 'result', is_error: false, result: 'ok' })
  spawned[0].end(0)
  const info = await ended
  assert.equal(spawned[0].killed, false)
  assert.equal(info.status, 'done')
})

test('stop cancels the turn; an error result and a crash report what went wrong', async (t) => {
  const { runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  let ended = done()
  assert.equal(runner.stop(session.id), true)
  assert.equal((await ended).status, 'cancelled')
  assert.equal(runner.stop(session.id), false)

  runner.run(session.id, 'y')
  ended = done()
  spawned[1].write({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' })
  spawned[1].end(1)
  assert.deepEqual(await ended, { id: session.id, status: 'error', text: '', error: 'error_max_turns', denials: [] })

  runner.run(session.id, 'z')
  ended = done()
  spawned[2].stderr.write('not logged in')
  spawned[2].end(2)
  const crash = await ended
  assert.match(crash.error, /終了コード 2[\s\S]*not logged in/)
  assert.equal(runner.turns(session.id).at(-1).error.message, crash.error)
})

test('sessions survive a restart; a turn the app cut off is marked so', async (t) => {
  const { dir, runner } = await setup(t)
  const session = await runner.create({ workspace: '/work', args: ['--x'] })
  runner.run(session.id, 'x')
  await runner.shutdown()
  // As if the app ended mid-turn.
  const file = path.join(dir, `${session.id}.json`)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  saved.turns.at(-1).status = 'running'
  await fs.writeFile(file, JSON.stringify(saved))
  const again = await new ClaudeRunner({ dir, spawn: fakeSpawn().spawn, findClaude: () => 'claude' }).load()
  assert.equal(again.get(session.id).sessionId, session.sessionId)
  assert.equal(again.get(session.id).state, 'idle')
  assert.match(again.turns(session.id).at(-1).error.message, /途中で止まりました/)
  await again.remove(session.id)
  assert.equal(again.get(session.id), null)
  await assert.rejects(fs.access(file))
})

test('applyEvent leaves out empty text and keeps a long tool output short', () => {
  const turn = { items: [] }
  assert.equal(applyEvent(turn, { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: '  ' }] } }), false)
  applyEvent(turn, { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a' } }] } })
  applyEvent(turn, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(9000), is_error: true }] } })
  assert.equal(turn.items[0].status, 'failed')
  assert.ok(turn.items[0].output.length < 8100)
})

test('removing a running session prevents a late exit from recreating its file', async (t) => {
  const { dir, runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  const proc = spawned[0]
  proc.kill = () => {}

  await runner.remove(session.id)
  assert.equal(runner.get(session.id), null)

  const ended = done()
  proc.end(0)
  await ended
  await runner.writes.get(session.id)
  await assert.rejects(fs.access(path.join(dir, `${session.id}.json`)))
})

test('what was denied is reported with a turn that ended in an error too', async (t) => {
  const { runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  await tick()
  const [proc] = spawned
  const ended = done()
  proc.write({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }] })
  await tick()
  proc.end(1)
  const info = await ended
  assert.equal(info.status, 'error')
  assert.deepEqual(info.denials, [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }])
})

const background = (...tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map(([task_id, description]) => ({ task_id, task_type: 'local_bash', description })) })

/** A runner whose waits on background commands are short enough to see. */
async function setupWaits(t, waits) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-runner-'))
  const { spawn, spawned } = fakeSpawn()
  const runner = await new ClaudeRunner({ dir, spawn, findClaude: () => '/usr/bin/claude', platform: 'linux', ...waits }).load()
  const finished = []
  runner.on('finished', (info) => finished.push(info))
  t.after(() => runner.shutdown())
  return { runner, spawned, finished }
}

test('an answer given while a background command runs is not the end: Claude Code goes on when it ends, and its last answer is the reply', async (t) => {
  const { runner, spawned, finished } = await setupWaits(t, {})
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'measure')
  await tick()
  const [proc] = spawned
  // As claude -p 2.1.309 reports it (stream-json, input left open).
  proc.write(init())
  proc.write(background(['b1', 'wide 60 runs']))
  proc.write({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'waiting for the run' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'waiting for the run' })
  await tick()
  assert.equal(proc.stdin.writableEnded, false)
  assert.equal(runner.running(session.id), true)
  assert.equal(finished.length, 0)
  // The command ends; Claude Code starts a turn of its own.
  proc.write({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })
  proc.write(background())
  proc.write(init())
  proc.write({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '集計しました' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: '集計しました', permission_denials: [{ tool_name: 'Write', tool_input: {} }] })
  await tick()
  assert.equal(proc.stdin.writableEnded, true)
  proc.end(0)
  await reported(finished)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].text, '集計しました')
  assert.equal(finished[0].denials.length, 1)
})

test('a background command that ends without a turn of its own ends the turn after a short wait', async (t) => {
  const { runner, spawned, finished } = await setupWaits(t, { wakeGraceMs: 20 })
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  await tick()
  const [proc] = spawned
  proc.write(background(['b1', 'build']))
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'started the build' })
  await tick()
  proc.write(background())
  await tick()
  assert.equal(proc.stdin.writableEnded, false)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(proc.stdin.writableEnded, true)
  proc.end(0)
  await reported(finished)
  assert.equal(finished[0].text, 'started the build')
})

test('a background command that outlasts the wait is left, and the report says so', async (t) => {
  const { runner, spawned, finished } = await setupWaits(t, { backgroundWaitMs: 20 })
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  await tick()
  const [proc] = spawned
  proc.write(background(['b1', 'npx vite']))
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'server is up' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(proc.stdin.writableEnded, true)
  proc.end(0)
  await reported(finished)
  assert.match(finished[0].text, /^server is up\n\n（バックグラウンドの作業が 0 分たっても終わらなかったため、待つのをやめました。止まった作業: npx vite）$/)
})

test('a background command still running when the turn answers keeps the input open for a message as well', async (t) => {
  const { runner, spawned } = await setupWaits(t, {})
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  await tick()
  const [proc] = spawned
  proc.write(background(['b1', 'tests']))
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: 'waiting' })
  await tick()
  // The leader's message reaches it while it waits.
  assert.equal(runner.steer(session.id, 'もう一つ'), true)
  assert.match(proc.input, /もう一つ/)
  runner.stop(session.id)
})
