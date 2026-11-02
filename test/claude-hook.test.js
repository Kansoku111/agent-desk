import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../server/claude-hook.js', import.meta.url))

/** Runs claude-hook.js on one hook input and returns what it posted to the server. */
async function forward(t, event) {
  let posted = null
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      posted = JSON.parse(body)
      res.writeHead(204).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      AGENT_DESK_TERMINAL_HOOK: `http://127.0.0.1:${server.address().port}/api/terminal-hook`,
      AGENT_DESK_TERMINAL_ID: 'terminal-1',
      AGENT_DESK_TERMINAL_SECRET: 'secret',
    },
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  child.stdin.end(JSON.stringify(event))
  await new Promise((resolve) => child.on('exit', resolve))
  return posted
}

test('a prompt is not forwarded, only the team messages it carries', async (t) => {
  const prompt = '\n\n<pasted_content id="097c">\n[Agent Desk チーム] #5140071c 子「A」から報告が届きました\n---\n本文\n</pasted_content id="097c">\nこれも見て'
  const posted = await forward(t, { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt })
  assert.equal(posted.id, 'terminal-1')
  assert.equal(posted.event.prompt, undefined)
  assert.deepEqual(posted.event.team_marks, ['5140071c'])
  // The user's own words carry none.
  const own = await forward(t, { hook_event_name: 'UserPromptSubmit', prompt: 'コミット #5140071c を見て' })
  assert.deepEqual(own.event.team_marks, [])
  const stop = await forward(t, { hook_event_name: 'Stop', last_assistant_message: 'done' })
  assert.equal(stop.event.team_marks, undefined)
  const id = '01234567-1234-4567-89ab-0123456789ab'
  const preset = await forward(t, { hook_event_name: 'UserPromptSubmit', prompt: '[Agent Desk: 独立レビュー / ' + id + ']\nprivate instructions' })
  assert.deepEqual(preset.event.task_preset_marks, [id])
  assert.equal(preset.event.prompt, undefined)
  assert.equal(JSON.stringify(preset).includes('private instructions'), false)
  assert.equal(own.event.usage_fallback_auto, false)
  assert.equal(own.event.usage_fallback_hash, createHash('sha256').update('コミット #5140071c を見て').digest('hex'))
  const fallback = await forward(t, { hook_event_name: 'UserPromptSubmit', prompt: '[Agent Desk 利用上限フォールバック] private history' })
  assert.equal(fallback.event.usage_fallback_auto, true)
  assert.equal(JSON.stringify(fallback).includes('private history'), false)
})
