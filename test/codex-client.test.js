import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { CodexClient, parseSse, codexProblem } from '../server/codex-client.js'
import { completedEvents } from '../server/responses-events.js'
test('retired private Codex client fails before touching credentials or network', () => {
  let calls = 0
  assert.throws(() => new CodexClient({ read: () => { calls++ } }), /retired/)
  assert.equal(calls, 0)
})
test('public Responses SSE parser reads completed events and ignores malformed data', () => {
  const events = parseSse('data: bad\n\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n')
  assert.equal(completedEvents(events).length, 1)
})
test('public Responses failure/incomplete/interruption are never successful', () => {
  for (const type of ['response.failed', 'response.incomplete', 'error']) assert.throws(() => completedEvents([{ type }]))
  assert.throws(() => completedEvents([]), /without response.completed/)
})
test('HTTP diagnostics preserve status and detail/error shapes', () => {
  assert.match(codexProblem(403, '{"detail":"policy denied"}'), /403.*policy denied/)
  assert.match(codexProblem(429, '{"error":{"message":"usage limit"}}'), /429.*usage limit/)
})
test('server sources contain no private ChatGPT transport or pi-ai Codex OAuth import', async () => {
  for (const file of (await fs.readdir(new URL('../server/', import.meta.url))).filter(file => file.endsWith('.js'))) {
    const text = await fs.readFile(new URL(`../server/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /backend-api|originator:\s*['"]pi['"]|providers\/openai-codex/, file)
  }
})
