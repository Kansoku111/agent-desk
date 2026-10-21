import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { ClaudeRunner, applyEvent } from '../server/claude-runner.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

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
    '--session-id', session.sessionId, '-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
    '--model', 'haiku', '--effort', 'low', '--append-system-prompt-file', 'child.md',
  ])
  assert.equal(proc.options.cwd, '/work')
  assert.equal(proc.options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(runner.get(session.id).state, 'running')
  assert.equal(runner.busy, true)
  await tick()
  assert.equal(proc.input, '効果音を作って')

  const ended = done()
  proc.write(init())
  proc.write({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '考える' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
  proc.write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.wav' }], is_error: false }] } })
  proc.write({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '作りました' }] } })
  proc.write({ type: 'result', subtype: 'success', is_error: false, result: '作りました', stop_reason: 'end_turn', permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'x' } }] })
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

test('a run that would use an API key is stopped before it does anything', async (t) => {
  const { runner, spawned, done } = await setup(t)
  const session = await runner.create({ workspace: '/work' })
  runner.run(session.id, 'x')
  const ended = done()
  spawned[0].write(init('ANTHROPIC_API_KEY'))
  const info = await ended
  assert.equal(spawned[0].killed, true)
  assert.equal(info.status, 'error')
  assert.match(info.error, /API キー（ANTHROPIC_API_KEY）/)
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
