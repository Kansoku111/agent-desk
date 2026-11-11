#!/usr/bin/env node
// Claude Code's PermissionRequest hook for AskUserQuestion (terminal-helpers.js hookSettings):
// it hands the questions to the Agent Desk server that started this Claude and waits
// until they are answered (or dismissed) in the chat view, then prints that decision.
// Claude Code keeps its own dialog up meanwhile and ends this hook when the question is
// answered or cancelled there. On any failure it prints nothing, which leaves the
// question to that dialog.
import http from 'node:http'

const hookUrl = process.env.AGENT_DESK_TERMINAL_HOOK
const id = process.env.AGENT_DESK_TERMINAL_ID
const secret = process.env.AGENT_DESK_TERMINAL_SECRET
const MAX_REPLY = 1024 * 1024

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  if (!hookUrl || !id || !secret || !/^http:\/\/127\.0\.0\.1:\d+\/api\/terminal-hook$/.test(hookUrl)) return
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }
  if (event?.hook_event_name !== 'PermissionRequest' || event.tool_name !== 'AskUserQuestion') return
  const body = JSON.stringify({ id, secret, input: event.tool_input })
  // node:http, not fetch: fetch gives up on a reply that takes over five minutes, and an answer can take hours.
  const request = http.request(hookUrl.replace(/\/api\/terminal-hook$/, '/api/terminal-question'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, (response) => {
    let reply = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      reply += chunk
      if (reply.length > MAX_REPLY) response.destroy()
    })
    response.on('end', () => {
      if (response.statusCode !== 200) return
      let decision
      try {
        decision = JSON.parse(reply)?.decision
      } catch {
        return
      }
      if (decision?.behavior === 'allow' || decision?.behavior === 'deny') {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
      }
    })
  })
  request.on('error', () => {})
  request.end(body)
})
