import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { teamConfig } from '../server/team-config.js'
import { childTurnArgs, leaderLaunch } from '../server/teams-launch.js'

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

test('without custom instructions a child prompt has no instructions section', () => {
  assert.doesNotMatch(promptOf(childTurnArgs({ child: { id: 'c2', name: 'B' }, dir: dir() })), /user_instructions/)
})
