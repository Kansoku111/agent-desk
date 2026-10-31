// Use the Harness filesystem provider so project roots, metadata and precedence
// match the skills that the agent can invoke, even before a session exists.
import { AgentDeskSkillProvider } from './skill-filesystem-plugin.js'

export async function listSkills(workspace, dshHome) {
  const controller = new AbortController()
  const provider = new AgentDeskSkillProvider(
    { get: () => undefined, logger: console },
    { signal: controller.signal, invalidate() {} },
    { dshHome, watch: false },
  )
  try {
    const result = await provider.list({ cwd: workspace })
    const candidates = Array.isArray(result) ? result : result.candidates
    const winners = new Map()
    for (const candidate of candidates.sort((a, b) => a.rank - b.rank)) {
      if (!winners.has(candidate.name)) winners.set(candidate.name, candidate)
    }
    return [...winners.values()]
      .filter((skill) => skill.invocation.userInvocable)
      .map(({ name, description }) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    await provider.dispose()
  }
}
