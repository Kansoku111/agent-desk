import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { teamConfig } from '../server/team-config.js'
import { childTurnArgs, leaderLaunch, leaderMcpServer } from '../server/teams-launch.js'
import { teamChildPatch } from '../server/dsh-config.js'
import YAML from 'yaml'

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
  assert.match(tm, /omit model, tier, provider and effort.*selected choices evenly/)
  assert.doesNotMatch(tm, /mid": work that needs judgment/)
  assert.doesNotMatch(tm, /rather than following a fixed sequence or review count/)
})

test('both planned eco leaders receive one-review instructions without conflicting eco guidance', () => {
  const options = {
    team: { id: 'eco', secret: 's', workspace: 'C:/work', execution: { planImplement: true } },
    config: teamConfig({}), models: [], dir: dir(), node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
  }
  const launch = leaderLaunch(options)
  const claudeEnv = JSON.parse(fs.readFileSync(launch.args[launch.args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers['agent-team'].env
  const server = leaderMcpServer(options)
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
  assert.equal(claudeEnv.AGENT_DESK_PLAN_IMPLEMENT, '1')
  assert.equal(env.AGENT_DESK_PLAN_IMPLEMENT, '1')
  for (const prompt of [promptOf(launch.args), fs.readFileSync(env.AGENT_DESK_TEAM_INSTRUCTIONS, 'utf8')]) {
    assert.match(prompt, /one user implementation request as one work unit/)
    assert.match(prompt, /ONE parent review/)
    assert.match(prompt, /Do not perform a second review/)
    assert.match(prompt, /consultation/)
    assert.doesNotMatch(prompt, /rather than following a fixed sequence or review count/)
    assert.doesNotMatch(prompt, /you may make a small scoped correction yourself/)
    assert.doesNotMatch(prompt, /handles at most two bounded repair attempts/)
    assert.doesNotMatch(prompt, /Only enable autoRepair/)
    assert.doesNotMatch(prompt, /Review both runs and the changed diff/)
  }
})

test('both leader runtimes receive every free-mode reasoning choice', () => {
  const options = {
    team: { id: 't', secret: 's', workspace: 'C:/work' },
    config: teamConfig({ modelMode: 'free', freeModels: [
      { provider: 'gpt', model: 'luna', effort: null },
      { provider: 'gpt', model: 'luna', effort: 'high' },
    ] }), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
  }
  const server = leaderMcpServer(options)
  const file = server.env.find(({ name }) => name === 'AGENT_DESK_TEAM_INSTRUCTIONS').value
  for (const prompt of [promptOf(leaderLaunch(options).args), fs.readFileSync(file, 'utf8')]) {
    assert.match(prompt, /omit model, tier, provider and effort/)
    assert.match(prompt, /reasoning level.*pass the requested choice to spawn/)
    assert.match(prompt, /provider "gpt", model "luna": luna, effort null/)
    assert.match(prompt, /provider "gpt", model "luna": luna, effort "high"/)
  }
})

test('TM and eco leaders, Claude or dsh, read the parent harness and never the playbook flag', () => {
  for (const execution of [undefined, {}]) {
    const options = {
      team: { id: 't', secret: 's', workspace: 'C:/work', execution }, config: teamConfig({}), models: [], dir: dir(),
      node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
      instructions: '通常のカスタム指示', harness: '親の規則',
    }
    const { args } = leaderLaunch(options)
    const prompt = promptOf(args)
    assert.match(prompt, /<parent_harness>\n親の規則\n<\/parent_harness>/)
    // The parent harness comes before the user's custom instructions, which stay last.
    assert.ok(prompt.indexOf('<parent_harness>') < prompt.indexOf('<user_instructions>'))
    const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'))
    assert.equal(mcp.mcpServers['agent-team'].env.AGENT_DESK_TEAM_PLAYBOOKS, undefined)

    const env = Object.fromEntries(leaderMcpServer(options).env.map(({ name, value }) => [name, value]))
    assert.match(fs.readFileSync(env.AGENT_DESK_TEAM_INSTRUCTIONS, 'utf8'), /<parent_harness>\n親の規則\n<\/parent_harness>/)
    assert.equal(env.AGENT_DESK_TEAM_PLAYBOOKS, undefined)
  }
})

test('without custom instructions a child prompt has no instructions section', () => {
  assert.doesNotMatch(promptOf(childTurnArgs({ child: { id: 'c2', name: 'B' }, dir: dir() })), /user_instructions/)
})

test('a Claude child reads the child harness, and nothing without one', () => {
  const prompt = promptOf(childTurnArgs({ child: { id: 'c3', name: 'C' }, dir: dir(), harness: '  子の規則  ', instructions: '通常のカスタム指示' }))
  assert.match(prompt, /<child_harness>\n子の規則\n<\/child_harness>/)
  assert.ok(prompt.indexOf('<child_harness>') < prompt.indexOf('<user_instructions>'))
  assert.doesNotMatch(promptOf(childTurnArgs({ child: { id: 'c4', name: 'D' }, dir: dir(), harness: ' \n ' })), /_harness>/)
  const { args } = leaderLaunch({
    team: { id: 't', secret: 's', workspace: 'C:/w' }, config: teamConfig({}), models: [], dir: dir(),
    node: 'node', script: 'team-mcp.js', apiUrl: 'http://127.0.0.1:1/api/team',
  })
  assert.doesNotMatch(promptOf(args), /_harness>/)
})

test('dsh children read the child harness from their layer', () => {
  const textOf = (patch) => YAML.parse(patch.split('\n').filter((line) => !line.startsWith('#')).join('\n'))
    .find((row) => row.insert?.[0]?.id === 'agent-desk-team-child').insert[0].config.text
  assert.match(textOf(teamChildPatch({ harness: '子の規則' })), /<child_harness>\n子の規則\n<\/child_harness>$/)
  assert.doesNotMatch(textOf(teamChildPatch()), /_harness>/)
})
