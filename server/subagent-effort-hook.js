#!/usr/bin/env node
// A Claude Code PreToolUse hook for the Agent tool (terminal-helpers.js hookSettings):
// it gives every subagent the reasoning level the user chose for Claude Code's
// own subagents (settings: subagentRoutes.cl), in AGENT_DESK_SUBAGENT_EFFORT.
//
// A subagent that runs on another model than the task does not inherit the task's level (it gets
// that model's default), and the Agent tool takes a level per call, which this sets. Built-in
// agents such as Explore keep their own prompts, which a same-named `--agents` entry would replace.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The hook's reply for one tool call, or null when there is nothing to set. */
export function subagentEffortReply(input, effort) {
  if (!LEVELS.includes(effort) || !input?.tool_input || typeof input.tool_input !== 'object') return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, effort } } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { raw += chunk })
  process.stdin.on('end', () => {
    let input = null
    try {
      input = JSON.parse(raw)
    } catch {}
    const reply = subagentEffortReply(input, process.env.AGENT_DESK_SUBAGENT_EFFORT)
    if (reply) process.stdout.write(JSON.stringify(reply))
  })
}
