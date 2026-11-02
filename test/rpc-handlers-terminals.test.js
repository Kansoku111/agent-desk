import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalHandlers } from '../server/rpc-handlers-terminals.js'

test('shared fallback auth RPC passes the confirmation to its owner', async () => {
  const handlers = createTerminalHandlers({ teams: { confirmFallbackAuth: async (...args) => ({ args }) } })
  assert.deepEqual(await handlers['fallback.confirmClaude']({ workspace: 'workspace', confirmation: { challenge: 'x' } }), { args: ['workspace', { challenge: 'x' }] })
})

test('a shared team fallback snapshot does not replace old saved defaults', async () => {
  const settings = { workspaces: [], agentTeams: { defaultModelMode: 'tiers', leaderFallback: 'old', fallbackEffort: 'high' } }
  const handlers = createTerminalHandlers({ paths: { myPc: 'home' },
    teams: { create: async () => ({ team: { workspace: 'home', sharedFallbackPolicy: true, config: { leaderFallback: 'resolved', fallbackEffort: 'low' } } }) },
    mutateSettings: async (fn) => fn(settings) })
  await handlers['team.create']({ workspace: 'home' })
  assert.equal(settings.agentTeams.leaderFallback, 'old')
  assert.equal(settings.agentTeams.fallbackEffort, 'high')
})

test('terminal.send answers something other than null, which the page takes as a failure', async () => {
  const sent = []
  const handlers = createTerminalHandlers({ terminals: { sendMessage: async (id, text) => { sent.push([id, text]) } } })
  assert.notEqual(await handlers['terminal.send']({ terminalId: 't1', text: 'こんにちは' }) ?? null, null)
  assert.deepEqual(sent, [['t1', 'こんにちは']])
})

test('question RPCs carry the screen identity and explicit input without using terminal.send', async () => {
  const calls = []
  const handlers = createTerminalHandlers({ terminals: {
    choose: (...args) => { calls.push(['choose', ...args]); return { chosen: '2' } },
    respond: (...args) => { calls.push(['respond', ...args]); return { sent: true } },
  } })
  assert.deepEqual(await handlers['terminal.choose']({ terminalId: 't', key: '2', label: 'GLB', dialogId: 'q1' }), { chosen: '2' })
  assert.deepEqual(await handlers['terminal.respond']({ terminalId: 't', dialogId: 'q2', text: '日本語' }), { sent: true })
  assert.deepEqual(calls, [
    ['choose', 't', '2', 'GLB', 'q1'],
    ['respond', 't', 'q2', { key: undefined, text: '日本語' }],
  ])
})
