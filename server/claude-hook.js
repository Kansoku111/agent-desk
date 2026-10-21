#!/usr/bin/env node
// Claude Code runs this for the hooks Agent Desk passes with `--settings` (see
// terminals.js): it forwards the hook's input to the Agent Desk server that
// started this Claude. Run any other way (no AGENT_DESK_TERMINAL_* variables), it does nothing.
const url = process.env.AGENT_DESK_TERMINAL_HOOK
const id = process.env.AGENT_DESK_TERMINAL_ID
const secret = process.env.AGENT_DESK_TERMINAL_SECRET
const MAX_REPLY = 60_000

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', async () => {
  if (!url || !id || !secret || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return
  let event
  try {
    event = JSON.parse(input)
  } catch {
    return
  }
  // The prompt and tool output are not needed, and can be large.
  const { prompt, tool_input: _input, tool_response: _response, ...rest } = event ?? {}
  // Which team messages a prompt carries (teams.js leaderMessage marks each one), so a team
  // knows its leader took a message even when Claude Code took it long after it was typed.
  if (rest.hook_event_name === 'UserPromptSubmit' && typeof prompt === 'string') {
    rest.team_marks = [...prompt.matchAll(/\[Agent Desk チーム\] #([0-9a-f]{8})/g)].map((match) => match[1])
  }
  // A team child's report is the reply its turn ended with; keep it under the server's size limit.
  if (typeof rest.last_assistant_message === 'string' && rest.last_assistant_message.length > MAX_REPLY) {
    rest.last_assistant_message = `${rest.last_assistant_message.slice(0, MAX_REPLY)}\n…`
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, secret, event: rest }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
})
