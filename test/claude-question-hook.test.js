import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../server/claude-question-hook.js', import.meta.url))
const ASKED = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] }

/** Runs the hook as Claude Code does (event on stdin) against a server that replies with `reply`. */
async function runHook(t, { reply, event = { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: ASKED }, path = '/api/terminal-hook' } = {}) {
  const received = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received.push({ url: req.url, body: JSON.parse(body) })
    if (reply === undefined) return res.writeHead(204).end()
    // An answer can take a long while; the reply only comes once it is given.
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)), 50)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = { ...process.env, AGENT_DESK_TERMINAL_HOOK: `http://127.0.0.1:${server.address().port}${path}`, AGENT_DESK_TERMINAL_ID: 'task-1', AGENT_DESK_TERMINAL_SECRET: 's3cret' }
  const child = spawn(process.execPath, [script], { env })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stdin.end(JSON.stringify(event))
  await new Promise((resolve) => child.on('exit', resolve))
  return { stdout, received }
}

test('the question hook hands the questions over and prints the decision given in chat', async (t) => {
  const decision = { behavior: 'allow', updatedInput: { ...ASKED, answers: { 'Which?': 'B' } } }
  const { stdout, received } = await runHook(t, { reply: { decision } })
  assert.deepEqual(received, [{ url: '/api/terminal-question', body: { id: 'task-1', secret: 's3cret', input: ASKED } }])
  assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
})

test('the question hook leaves the question to Claude Code\'s own dialog when it gets no decision', async (t) => {
  assert.equal((await runHook(t, {})).stdout, '')
  assert.equal((await runHook(t, { reply: { decision: null } })).stdout, '')
  assert.equal((await runHook(t, { reply: { decision: { behavior: 'ask' } } })).stdout, '')
  const other = await runHook(t, { reply: { decision: { behavior: 'allow' } }, event: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} } })
  assert.deepEqual([other.stdout, other.received], ['', []])
  const elsewhere = await runHook(t, { reply: { decision: { behavior: 'allow' } }, path: '/elsewhere' })
  assert.deepEqual([elsewhere.stdout, elsewhere.received], ['', []])
})
