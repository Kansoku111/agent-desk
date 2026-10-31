// Use the Harness filesystem provider so project roots, metadata and precedence
// match the skills that the agent can invoke, even before a session exists.
import path from 'node:path'
import { AgentDeskSkillProvider } from './skill-filesystem-plugin.js'

async function discover(workspace, dshHome) {
  const controller = new AbortController()
  const provider = new AgentDeskSkillProvider(
    { get: () => undefined, logger: console },
    { signal: controller.signal, invalidate() {} },
    { dshHome, watch: false },
  )
  try {
    const result = await provider.list({ cwd: workspace })
    const candidates = Array.isArray(result) ? result : result.candidates
    return candidates.sort((a, b) => a.rank - b.rank)
  } finally {
    await provider.dispose()
  }
}

export async function listSkills(workspace, dshHome) {
  const winners = new Map()
  for (const candidate of await discover(workspace, dshHome)) {
    if (!winners.has(candidate.name)) winners.set(candidate.name, candidate)
  }
  return [...winners.values()]
    .filter((skill) => skill.invocation.userInvocable)
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Ranks 210-211 are the project .codex/.claude roots added by the Agent Desk
// plugin; the Harness reports them as plain "custom" roots.
function scopeOf({ source, rank }) {
  if (source === 'bundled') return 'bundled'
  if (source.startsWith('project-') || (source === 'custom' && rank >= 200 && rank < 300)) return 'project'
  return 'user'
}

// ".claude/skills" for <root>/<skill>/SKILL.md or a flat <root>/<skill>.md.
function rootLabel({ path: file, directory }) {
  const root = path.basename(file) === 'SKILL.md' ? path.dirname(directory) : directory
  return `${path.basename(path.dirname(root))}/${path.basename(root)}`
}

/** Every discovered skill, including the ones that lose to a same-named skill with a higher precedence. */
export async function listSkillOverview(workspace, dshHome) {
  const seen = new Set()
  return (await discover(workspace, dshHome)).map((skill) => {
    const active = !seen.has(skill.name)
    seen.add(skill.name)
    return {
      name: skill.name,
      description: skill.description,
      scope: scopeOf(skill),
      root: rootLabel(skill.locator),
      file: skill.locator.path,
      // What deleting the skill removes: its folder, or the flat Markdown file itself.
      target: path.basename(skill.locator.path) === 'SKILL.md' ? skill.locator.directory : skill.locator.path,
      active,
      userInvocable: skill.invocation.userInvocable,
      modelInvocable: skill.invocation.modelInvocable,
    }
  })
}
