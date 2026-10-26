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

test('eco leader guidance keeps strategy flexible without TM parallel-write or mid-tier advice', () => {
  const options = {
    team: { id: 'eco', secret: 's', workspace: 'C:/work', execution: {} },
    config: teamConfig({}), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
  }
  const server = leaderMcpServer(options)
  const file = server.env.find(({ name }) => name === 'AGENT_DESK_TEAM_INSTRUCTIONS').value
  for (const prompt of [promptOf(leaderLaunch(options).args), fs.readFileSync(file, 'utf8')]) {
    assert.match(prompt, /only read-only research may run in parallel/)
    assert.match(prompt, /Keep one writer through verification and judgment/)
    assert.match(prompt, /Children use only tier "low"/)
    assert.match(prompt, /rather than following a fixed sequence or review count/)
    assert.doesNotMatch(prompt, /start one child per part.*all at once|mid": work that needs judgment/)
  }
  const tm = promptOf(leaderLaunch({ ...options, team: { ...options.team, execution: undefined } }).args)
  assert.match(tm, /start one child per part.*all at once/)
  assert.match(tm, /mid": work that needs judgment/)
  assert.doesNotMatch(tm, /rather than following a fixed sequence or review count/)
})

test('eco leaders ignore TM policy and playbooks even when explicitly supplied', () => {
  const options = {
    team: { id: 'eco', secret: 's', workspace: 'C:/work', execution: {} },
    config: teamConfig({ policy: 'p1' }), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
    instructions: '通常のカスタム指示',
    guides: { policy: 'TM専用の方針', playbooks: [{ name: 'TM専用の手順', description: 'TM専用の場面' }] },
  }
  const { args } = leaderLaunch(options)
  const prompt = promptOf(args)
  assert.doesNotMatch(prompt, /team_policy|Playbooks|TM専用/)
  assert.match(prompt, /通常のカスタム指示/)
  const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
  assert.equal(mcp.mcpServers['agent-team'].env.AGENT_DESK_TEAM_PLAYBOOKS, undefined)
  assert.equal(mcp.mcpServers['agent-team'].env.AGENT_DESK_EXECUTION, '1')

  const server = leaderMcpServer(options)
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
  assert.doesNotMatch(fs.readFileSync(env.AGENT_DESK_TEAM_INSTRUCTIONS, 'utf8'), /team_policy|Playbooks|TM専用/)
  assert.equal(env.AGENT_DESK_TEAM_PLAYBOOKS, undefined)
  assert.equal(env.AGENT_DESK_EXECUTION, '1')
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
