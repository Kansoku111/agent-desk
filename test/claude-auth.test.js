import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { authDescriptor, authProblem, checkClaudeAuth, claudeAuthStatus, TeamClaudeAuth, AUTH_REQUIRED } from '../server/claude-auth.js'
import { ClaudeRunner } from '../server/claude-runner.js'

test('descriptors distinguish auth modes and never retain tokens or email', () => {
  for (const [authMethod, apiProvider, mode] of [['claude.ai', 'firstParty', 'subscription'], ['api_key', 'firstParty', 'api'], ['api_key_helper', 'firstParty', 'api'], ['third_party', 'bedrock', 'cloud'], ['third_party', 'vertex', 'cloud'], ['third_party', 'foundry', 'cloud']]) {
    const status = { loggedIn: true, authMethod, apiProvider, email: 'private@example.test', token: 'SECRET' }
    assert.equal(authDescriptor(status).mode, mode)
    assert.equal(authProblem(status), null)
    assert.doesNotMatch(JSON.stringify(authDescriptor(status)), /private|SECRET/)
  }
  assert.match(authProblem({ loggedIn: false }), /ログインしていません/)
  for (const status of [null, 'nope', {}, { loggedIn: true, authMethod: 'SECRET', apiProvider: 'private@example.test' }]) assert.equal(authDescriptor(status).mode, 'unknown')
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
  assert.equal(await checkClaudeAuth({ claude: '/usr/bin/claude', cwd: '/work', env }, { spawn }), AUTH_REQUIRED)
})

test('a check that fails, prints nothing readable or hangs gives no answer', async () => {
  assert.equal(await claudeAuthStatus({ claude: 'c', cwd: '/w', env: {}, spawn: fakeAuthSpawn('not json').spawn }), null)
  assert.equal(await claudeAuthStatus({ claude: 'c', cwd: '/w', env: {}, spawn: () => { throw new Error('ENOENT') } }), null)
  const hung = fakeAuthSpawn('', { hang: true })
  // The check's own timer is unref'd (a real run has the child process to keep the loop up); this fake has none.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.equal(await claudeAuthStatus({ claude: 'c', cwd: '/w', env: {}, spawn: hung.spawn, timeoutMs: 20 }), null)
  } finally {
    clearInterval(keepAlive)
  }
  assert.equal(hung.calls.length, 1)
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
  assert.equal(asked[0].env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY)
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

test('every resumed child turn rechecks auth before spawning', async (t) => {
  let checks = 0
  const { runner, spawned, session, finished } = await setup(t, async () => ++checks === 1 ? null : AUTH_REQUIRED)
  runner.run(session.id, 'first')
  await new Promise((resolve) => setImmediate(resolve))
  const proc = spawned[0]
  proc.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`)
  proc.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: 'ok' })}\n`)
  proc.stdout.end(); proc.stderr.end(); proc.emit('close', 0)
  await finished
  const second = new Promise((resolve) => runner.once('finished', resolve))
  runner.run(session.id, 'resume')
  assert.equal((await second).status, 'error')
  assert.equal(checks, 2)
  assert.equal(spawned.length, 1)
})

test('a check that throws fails closed without starting the run', async (t) => {
  const { runner, spawned, session, finished } = await setup(t, async () => { throw new Error('boom') })
  runner.run(session.id, 'x')
  assert.equal((await finished).status, 'error')
  assert.equal(spawned.length, 0)
})

for (const [authMethod, apiProvider] of [['claude.ai', 'firstParty'], ['api_key', 'firstParty'], ['api_key_helper', 'firstParty'], ['third_party', 'bedrock'], ['third_party', 'vertex'], ['third_party', 'foundry']]) {
  test(`explicit per-team consent permits ${authMethod}/${apiProvider} and drift requires reconfirmation`, async () => {
    let status = { loggedIn: true, authMethod, apiProvider }
    const auth = new TeamClaudeAuth({ detect: async () => status, find: () => 'fake' })
    const team = { id: 'a', workspace: '/work' }
    assert.equal(await auth.guard(team, {}), AUTH_REQUIRED)
    const view = await auth.inspect('/work', team)
    assert.equal(view.confirmed, false)
    await auth.confirm(team, { challenge: view.challenge })
    assert.equal(await auth.guard(team, {}), null)
    assert.equal((await auth.inspect('/work', team)).confirmed, true)
    // The box is ticked once: another team or folder with the same auth mode needs no second tick.
    assert.equal(await auth.guard({ id: 'b', workspace: '/other' }, {}), null)
    assert.equal((await auth.inspect('/other', { id: 'c', workspace: '/other' })).confirmed, true)
    status = null
    assert.equal(await auth.guard(team, {}), AUTH_REQUIRED)
    // A different mode is not covered by the earlier tick.
    status = { loggedIn: true, authMethod: authMethod === 'claude.ai' ? 'api_key' : 'claude.ai', apiProvider: 'firstParty' }
    assert.equal(await auth.guard({ id: 'b', workspace: '/other' }, {}), AUTH_REQUIRED)
    status = { loggedIn: false }
    assert.match(await auth.guard(team, {}), /ログインしていません/)
  })
}

test('unknown consent requires explicit risk acknowledgement; challenges expire and bind workspace/team', async () => {
  let now = 0
  const auth = new TeamClaudeAuth({ detect: async () => { throw new Error('private failure') }, find: () => 'fake', now: () => now })
  const team = { id: 'a', workspace: '/work' }
  const view = await auth.inspect('/work', team)
  assert.equal(view.descriptor.mode, 'unknown')
  await assert.rejects(auth.confirm(team, { challenge: view.challenge }), /不明/)
  await assert.rejects(auth.confirm({ ...team, id: 'b' }, { challenge: view.challenge, acknowledgeUnknown: true }))
  await assert.rejects(auth.confirm({ ...team, workspace: '/other' }, { challenge: view.challenge, acknowledgeUnknown: true }))
  await auth.confirm(team, { challenge: view.challenge, acknowledgeUnknown: true })
  assert.equal(await auth.guard(team, {}), null)
  await assert.rejects(auth.confirm(team, { challenge: view.challenge, acknowledgeUnknown: true }))
  const expired = await auth.inspect('/work', team)
  now = 300001
  await assert.rejects(auth.confirm(team, { challenge: expired.challenge, acknowledgeUnknown: true }))
})

test('concurrent confirmation cannot replay a challenge or authorize a removed team', async () => {
  const status = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }
  const auth = new TeamClaudeAuth({ detect: async () => status, find: () => 'fake' })
  const team = { id: 'a', workspace: '/work' }
  const view = await auth.inspect('/work', team)
  let release
  auth.detect = () => new Promise((resolve) => { release = () => resolve(status) })
  const pending = auth.confirm(team, { challenge: view.challenge }, true, () => false)
  await assert.rejects(auth.confirm(team, { challenge: view.challenge }))
  release()
  await assert.rejects(pending)
  assert.equal(team.claudeAuthConsent, undefined)
})

test('confirmation rechecks auth and logged-out inspections cannot be approved', async () => {
  let status = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }
  const auth = new TeamClaudeAuth({ detect: async () => status, find: () => 'fake' })
  const team = { id: 'a', workspace: '/work' }
  const view = await auth.inspect('/work', team)
  status = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }
  await assert.rejects(auth.confirm(team, { challenge: view.challenge }))
  status = { loggedIn: false }
  assert.equal((await auth.inspect('/work', team)).challenge, null)
  assert.equal(team.claudeAuthConsent, undefined)
})

test('a confirmation survives a restart through restore, and only for its own auth mode', async () => {
  const status = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }
  const first = new TeamClaudeAuth({ detect: async () => status, find: () => 'fake' })
  const team = { id: 'a', workspace: '/work' }
  await first.confirm(team, { challenge: (await first.inspect('/work', team)).challenge })
  const saved = JSON.parse(JSON.stringify(first.accepted))
  const second = new TeamClaudeAuth({ detect: async () => status, find: () => 'fake' })
  second.restore(saved)
  assert.equal(await second.guard({ id: 'b', workspace: '/elsewhere' }, {}), null)
  second.restore('garbage')
  assert.equal(await second.guard({ id: 'b', workspace: '/elsewhere' }, {}), AUTH_REQUIRED)
})
