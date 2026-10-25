import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { teamConfig } from '../server/team-config.js'
import { leaderGuides } from '../server/team-playbooks.js'
import { childTurnArgs, leaderLaunch, leaderMcpServer } from '../server/teams-launch.js'

const promptOf = (args) => fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-launch-'))

test('a Claude child and leader get the custom instructions in their one appended prompt', () => {
  const instructions = 'コミット判断はあなたで行ってください。'
  const child = promptOf(childTurnArgs({ child: { id: 'c1', name: 'A' }, dir: dir(), instructions }))
  assert.match(child, /<user_instructions>\nコミット判断はあなたで行ってください。\n<\/user_instructions>/)
  const { args } = leaderLaunch({
    team: { id: 't', secret: 's', workspace: 'C:\w' }, config: teamConfig({}), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team', instructions,
  })
  assert.equal(args.filter((arg) => arg === '--append-system-prompt-file').length, 1)
  assert.match(promptOf(args), /<user_instructions>\nコミット判断はあなたで行ってください。\n<\/user_instructions>/)
})

test('eco leader prompts do not request opt-in tools even with saved lean settings', () => {
  const options = {
    team: { id: 'eco', secret: 's', workspace: 'C:/work', execution: {} },
    config: teamConfig({ leanChildren: true }), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
  }
  assert.doesNotMatch(promptOf(leaderLaunch(options).args), /`spawn` with `tools: true`/)
  const server = leaderMcpServer(options)
  const file = server.env.find(({ name }) => name === 'AGENT_DESK_TEAM_INSTRUCTIONS').value
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /`spawn` with `tools: true`/)
})

test('without custom instructions a child prompt has no instructions section', () => {
  assert.doesNotMatch(promptOf(childTurnArgs({ child: { id: 'c2', name: 'B' }, dir: dir() })), /user_instructions/)
})

test('a leader reads its policy in full and the playbooks by name only', () => {
  const guides = leaderGuides({
    policies: [{ id: 'p1', name: 'Claude中心', text: '設計は Claude の中枠に任せる' }, { id: 'p2', name: '節約', text: '低枠を使う' }],
    playbooks: [{ id: 'b1', name: '大改修', description: '大きな改修を\n始めるとき', body: '手順の本文' }],
    policy: 'p1',
  })
  const { args } = leaderLaunch({
    team: { id: 't', secret: 's', workspace: 'C:\w' }, config: teamConfig({ policy: 'p1' }), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team', guides,
  })
  const prompt = promptOf(args)
  assert.match(prompt, /<team_policy>\n設計は Claude の中枠に任せる\n<\/team_policy>/)
  assert.doesNotMatch(prompt, /低枠を使う/)
  assert.match(prompt, /- "大改修": 大きな改修を 始めるとき/)
  assert.doesNotMatch(prompt, /手順の本文/)
  const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
  assert.equal(mcp.mcpServers['agent-team'].env.AGENT_DESK_TEAM_PLAYBOOKS, '1')
})

test('a leader without policy or playbooks gets neither section nor the playbook tool', () => {
  const { args } = leaderLaunch({
    team: { id: 't', secret: 's', workspace: 'C:\w' }, config: teamConfig({ policy: 'gone' }), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
    guides: leaderGuides({ policies: [], playbooks: [], policy: 'gone' }),
  })
  assert.doesNotMatch(promptOf(args), /team_policy|Playbooks/)
  const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
  assert.equal(mcp.mcpServers['agent-team'].env.AGENT_DESK_TEAM_PLAYBOOKS, undefined)
})

test('a GPT leader gets the policy in its MCP instructions and the playbook tool with playbooks', () => {
  const server = leaderMcpServer({
    team: { id: 't', secret: 's', workspace: 'C:\w' }, config: teamConfig({}), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
    guides: { policy: '節約する', playbooks: [{ name: '調査', description: '' }] },
  })
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
  assert.equal(env.AGENT_DESK_TEAM_PLAYBOOKS, '1')
  const prompt = fs.readFileSync(env.AGENT_DESK_TEAM_INSTRUCTIONS, 'utf8')
  assert.match(prompt, /<team_policy>\n節約する\n<\/team_policy>/)
  assert.match(prompt, /- "調査"$/m)
})
