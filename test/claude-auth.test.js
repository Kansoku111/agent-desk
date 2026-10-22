import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { authProblem, checkClaudeAuth, claudeAuthStatus } from '../server/claude-auth.js'
import { ClaudeRunner } from '../server/claude-runner.js'

test('only the Claude subscription may run a team child; an API key, a helper or a cloud account may not', () => {
  assert.equal(authProblem({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), null)
  assert.match(authProblem({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }), /API キーで動こう/)
  assert.match(authProblem({ loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' }), /apiKeyHelper/)
  assert.match(authProblem({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }), /Amazon Bedrock/)
  assert.match(authProblem({ loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' }), /Vertex/)
  assert.match(authProblem({ loggedIn: false }), /ログインしていません/)
  // The refusal says where to go instead.
  assert.match(authProblem({ authMethod: 'api_key' }), /Claude（API）/)
})

test('an answer that cannot be read lets the run through (the run still checks its own first event)', () => {
  assert.equal(authProblem(null), null)
  assert.equal(authProblem('nope'), null)
  assert.equal(authProblem({ authMethod: 'something_new' }), null)
})

function fakeAuthSpawn(output, { exit = 0, hang = false } = {}) {
  const calls = []
  const spawn = (file, args, options) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), killed: false })
    proc.kill = () => { proc.killed = true }
    calls.push({ file, args, options })
    if (!hang) {
      setImmediate(() => {
        proc.stdout.end(output)
        setImmediate(() => proc.emit('close', exit))
      })
    }
    return proc
  }
  return { spawn, calls }
}

test('claudeAuthStatus runs `claude auth status` in the workspace with the given environment and parses its JSON', async () => {
  const { spawn, calls } = fakeAuthSpawn('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}\n')
  const env = { PATH: 'x' }
  const status = await claudeAuthStatus({ claude: '/usr/bin/claude', cwd: '/work', env, spawn })
  assert.equal(status.authMethod, 'api_key')
  assert.deepEqual(calls[0].args, ['auth', 'status'])
  assert.equal(calls[0].options.cwd, '/work')
  assert.equal(calls[0].options.env, env)
  assert.match(await checkClaudeAuth({ claude: '/usr/bin/claude', cwd: '/work', env }, { spawn }), /API キー/)
})

test('a check that fails, prints nothing readable or hangs gives no answer', async () => {
  assert.equal(await claudeAuthStatus({ claude: 'c', cwd: '/w', env: {}, spawn: fakeAuthSpawn('not json').spawn }), null)
  assert.equal(await claudeAuthStatus({ claude: 'c', cwd: '/w', env: {}, spawn: () => { throw new Error('ENOENT') } }), null)
  const hung = fakeAuthSpawn('', { hang: true })
  assert.equal(await claudeAuthStatus({ claude: 'c', cwd: '/w', env: {}, spawn: hung.spawn, timeoutMs: 20 }), null)
})

// ------------------------------------------------------------ the runner

function fakeRunSpawn() {
  const spawned = []
  const spawn = (file, args, options) => {
    const proc = Object.assign(new EventEmitter(), {
      file, args, options, pid: 6000 + spawned.length, exitCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
    })
    spawned.push(proc)
    return proc
  }
  return { spawn, spawned }
}

async function setup(t, preflight) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-auth-'))
  const { spawn, spawned } = fakeRunSpawn()
  const runner = await new ClaudeRunner({ dir, spawn, preflight, findClaude: () => '/usr/bin/claude', platform: 'linux' }).load()
  t.after(() => runner.shutdown())
  const session = await runner.create({ workspace: '/work' })
  const finished = new Promise((resolve) => runner.once('finished', resolve))
  return { runner, spawned, session, finished }
}

test('a turn whose sign-in is refused never starts claude, and ends as an error with the reason', async (t) => {
  const asked = []
  const { runner, spawned, session, finished } = await setup(t, async (context) => {
    asked.push(context)
    return 'API キーなので起動しません'
  })
  assert.equal(runner.run(session.id, 'x').state, 'running')
  const info = await finished
  assert.equal(spawned.length, 0)
  assert.equal(info.status, 'error')
  assert.equal(info.error, 'API キーなので起動しません')
  assert.equal(runner.busy, false)
  assert.equal(asked[0].claude, '/usr/bin/claude')
  assert.equal(asked[0].cwd, '/work')
  assert.equal(asked[0].env.ANTHROPIC_API_KEY, undefined)
})

test('a turn whose sign-in passes starts claude after the check and runs as usual', async (t) => {
  const { runner, spawned, session, finished } = await setup(t, async () => null)
  runner.run(session.id, 'こんにちは')
  assert.equal(spawned.length, 0)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawned.length, 1)
  const [proc] = spawned
  proc.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'm', apiKeySource: 'none' })}\n`)
  proc.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '返事', permission_denials: [] })}\n`)
  proc.exitCode = 0
  proc.stdout.end()
  proc.stderr.end()
  setImmediate(() => proc.emit('close', 0))
  const info = await finished
  assert.equal(info.status, 'done')
  assert.equal(info.text, '返事')
})

test('stopping a turn while its sign-in is being checked cancels it without starting claude', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { runner, spawned, session, finished } = await setup(t, async () => {
    await gate
    return null
  })
  runner.run(session.id, 'x')
  assert.equal(runner.stop(session.id), true)
  release()
  assert.equal((await finished).status, 'cancelled')
  assert.equal(spawned.length, 0)
})

test('a check that throws does not stop the run', async (t) => {
  const { runner, spawned, session, finished } = await setup(t, async () => { throw new Error('boom') })
  runner.run(session.id, 'x')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawned.length, 1)
  const [proc] = spawned
  proc.exitCode = 0
  proc.stdout.end()
  proc.stderr.end()
  setImmediate(() => proc.emit('close', 0))
  await finished
})
