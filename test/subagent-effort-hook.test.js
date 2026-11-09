import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { hookSettings } from '../server/terminal-helpers.js'
import { subagentEffortReply } from '../server/subagent-effort-hook.js'

const script = fileURLToPath(new URL('../server/subagent-effort-hook.js', import.meta.url))

test('the reply keeps every field of the Agent call and adds the level', () => {
  const input = { tool_name: 'Agent', tool_input: { description: 'look', prompt: 'read it', subagent_type: 'Explore', run_in_background: true } }
  assert.deepEqual(subagentEffortReply(input, 'low'), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, effort: 'low' } },
  })
  // The user's choice replaces a level the model asked for.
  assert.equal(subagentEffortReply({ tool_input: { prompt: 'x', effort: 'max' } }, 'low').hookSpecificOutput.updatedInput.effort, 'low')
})

test('nothing is set for an unknown level or an input that is not an object', () => {
  for (const effort of [undefined, '', 'minimal', 'low; rm -rf /', 'LOW', 3]) assert.equal(subagentEffortReply({ tool_input: { prompt: 'x' } }, effort), null, String(effort))
  for (const input of [null, undefined, {}, { tool_input: null }, { tool_input: 'x' }]) assert.equal(subagentEffortReply(input, 'low'), null)
})

test('as the hook process it reads the level from the environment and stays silent without one', () => {
  const run = (env, stdin) => spawnSync(process.execPath, [script], { input: stdin, env: { ...process.env, AGENT_DESK_SUBAGENT_EFFORT: '', ...env }, encoding: 'utf8' })
  const called = run({ AGENT_DESK_SUBAGENT_EFFORT: 'high' }, JSON.stringify({ tool_input: { prompt: 'p' } }))
  assert.equal(called.status, 0)
  assert.deepEqual(JSON.parse(called.stdout).hookSpecificOutput.updatedInput, { prompt: 'p', effort: 'high' })
  for (const [env, stdin] of [[{}, '{"tool_input":{"prompt":"p"}}'], [{ AGENT_DESK_SUBAGENT_EFFORT: 'high' }, 'not json'], [{ AGENT_DESK_SUBAGENT_EFFORT: 'warp' }, '{"tool_input":{}}']]) {
    const silent = run(env, stdin)
    assert.equal(silent.status, 0)
    assert.equal(silent.stdout, '')
  }
})

test('the settings add the hook only when a level is chosen, and run it synchronously on the Agent tool', () => {
  assert.equal(hookSettings('node', 'claude-hook.js').hooks.PreToolUse, undefined)
  const settings = hookSettings('C:\\Program Files\\nodejs\\node.exe', 'F:\\app\\server\\claude-hook.js', { subagentEffort: true })
  const [entry] = settings.hooks.PreToolUse
  assert.equal(entry.matcher, 'Agent|Task')
  assert.equal(entry.hooks[0].async, undefined)
  assert.match(entry.hooks[0].command, /^"C:\/Program Files\/nodejs\/node\.exe" ".*\/server\/subagent-effort-hook\.js"$/)
  // The event hooks that report to Agent Desk are unchanged.
  assert.equal(settings.hooks.Stop[0].hooks[0].command, '"C:/Program Files/nodejs/node.exe" "F:/app/server/claude-hook.js"')
})
