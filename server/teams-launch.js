// What a team's leader and Claude children start with: the MCP server config,
// the instructions file and the flags of their turns (teams.js writes them each
// time: the server's port may have changed).
import fs from 'node:fs'
import path from 'node:path'
import { instructionsSection } from './instructions-plugin.js'
import { childPrompt, leaderPrompt, tierLines } from './teams-prompts.js'
import { EXECUTION_PROMPT } from './execution.js'

/** The leader's MCP server; its tools are mcp__agent-team__spawn and so on. */
export const MCP_SERVER = 'agent-team'

/**
 * Tools a Claude child does without: those that would stop it waiting for a
 * person, and those that start other agents (subagents, workflows, scheduled
 * or remote runs). A child does its own work, so the team stays the size the
 * user set and everything that runs shows in the team panel. GPT, DeepSeek and
 * other dsh children run in dsh processes without subagent tools (dsh-config.js teamChildPatch).
 */
const CHILD_DISALLOWED = [
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'Task', 'Agent', 'Workflow', 'SendMessage', 'ListAgents', 'RemoteTrigger', 'CronCreate', 'ScheduleWakeup',
].join(',')

/** A leader without the user's policy or playbooks (team-playbooks.js leaderGuides). */
const NO_GUIDES = { policy: '', playbooks: [] }

/** Writes a file a Claude Code reads (its MCP config, its instructions). */
function writeFile(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  return file
}

/** A team's prompt with the user's custom instructions after it (one --append-system-prompt-file carries both). */
function withInstructions(prompt, instructions) {
  const section = instructionsSection(instructions)
  return section ? `${prompt}

${section}` : prompt
}

/**
 * The flags a team leader's Claude Code starts with (TerminalManager's
 * `launch`). The files are written each time: the server's port may have changed.
 */
export function leaderLaunch({ team, config, models, dir, node, script, apiUrl, instructions = '', guides = NO_GUIDES }) {
  // Policy and playbooks belong to TM, not eco (including previously saved teams).
  if (team.execution) guides = NO_GUIDES
  const mcp = writeFile(dir, 'mcp.json', JSON.stringify({
    mcpServers: {
      [MCP_SERVER]: {
        type: 'stdio',
        command: node,
        args: [script],
        env: {
          AGENT_DESK_TEAM_URL: apiUrl, AGENT_DESK_TEAM_ID: team.id, AGENT_DESK_TEAM_SECRET: team.secret,
          ...(team.execution ? { AGENT_DESK_EXECUTION: '1' } : {}),
          ...(guides.playbooks.length ? { AGENT_DESK_TEAM_PLAYBOOKS: '1' } : {}),
        },
      },
    },
  }, null, 2))
  const prompt = writeFile(dir, 'leader.md', withInstructions(leaderPrompt({
    workspace: team.workspace, maxChildren: config.maxChildren, tiers: tierLines(config, models), lean: !team.execution && config.leanChildren, execution: Boolean(team.execution), ...guides,
  }) + (team.execution ? EXECUTION_PROMPT : ''), instructions))
  return {
    args: [
      ...(config.leaderBypass ? ['--permission-mode', 'bypassPermissions'] : []),
      '--mcp-config', mcp,
      ...(team.execution ? ['--disallowedTools', CHILD_DISALLOWED] : []),
      // The team's own tools never ask, whatever the permission mode.
      '--allowedTools', `mcp__${MCP_SERVER}`,
      '--append-system-prompt-file', prompt,
    ],
  }
}

/**
 * The MCP server a GPT leader's dsh session mounts (index.js mcpServersFor):
 * the team's tools, with its instructions as the server's own. Written each
 * time a session starts: the server's port may have changed.
 */
export function leaderMcpServer({ team, config, models, dir, node, script, apiUrl, guides = NO_GUIDES }) {
  if (team.execution) guides = NO_GUIDES
  const prompt = writeFile(dir, 'leader.md', leaderPrompt({
    workspace: team.workspace, maxChildren: config.maxChildren, tiers: tierLines(config, models), gpt: true, lean: !team.execution && config.leanChildren, execution: Boolean(team.execution), ...guides,
  }) + (team.execution ? EXECUTION_PROMPT : ''))
  return {
    name: MCP_SERVER,
    command: node,
    args: [script],
    env: [
      { name: 'AGENT_DESK_TEAM_URL', value: apiUrl },
      { name: 'AGENT_DESK_TEAM_ID', value: team.id },
      { name: 'AGENT_DESK_TEAM_SECRET', value: team.secret },
      { name: 'AGENT_DESK_TEAM_INSTRUCTIONS', value: prompt },
      ...(team.execution ? [{ name: 'AGENT_DESK_EXECUTION', value: '1' }] : []),
      ...(guides.playbooks.length ? [{ name: 'AGENT_DESK_TEAM_PLAYBOOKS', value: '1' }] : []),
    ],
  }
}

/**
 * The flags of every turn of a Claude child: no approvals (what would still
 * ask is denied, and the report lists it), no tools that wait for a person.
 * A `lean` child has no MCP servers: their tools would be in every turn.
 * Any other child gets Claude in Chrome, which `-p` leaves out without `--chrome`
 * (and `--strict-mcp-config` keeps when it is asked for).
 */
export function childTurnArgs({ child, dir, instructions = '', lean = false }) {
  const prompt = writeFile(dir, `${child.id}.md`, withInstructions(childPrompt(child.name, { background: true }), instructions))
  return [
    '--permission-mode', 'bypassPermissions', '--disallowedTools', CHILD_DISALLOWED, '--append-system-prompt-file', prompt,
    ...(child.execution?.mode === 'research' ? ['--tools', 'Read,Glob,Grep'] : []),
    ...(lean ? ['--strict-mcp-config', '--no-chrome'] : ['--chrome']),
  ]
}
