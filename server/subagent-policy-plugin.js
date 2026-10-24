// Live execution gate while an existing turn finishes with its old tool catalog.
// New runtimes omit disabled delegation plugins entirely (dsh-config.js).
import fs from 'node:fs'

export const name = 'agent-desk-subagent-policy'
export const inject = ['tools']

const START_TOOLS = new Set(['subagent', 'subagent_fork', 'subagent_gpt', 'subagent_claude', 'workflow'])

export function subagentsAllowed(settingsFile) {
  if (!settingsFile) return true
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).subagentsEnabled !== false
  } catch (error) {
    // Old installations with no saved settings retain the default. A broken
    // settings file must not accidentally reopen a disabled capability.
    return error.code === 'ENOENT'
  }
}

export function apply(ctx, config) {
  ctx.tools.guard((exec) => {
    if (START_TOOLS.has(exec.name) && !subagentsAllowed(config?.settingsFile)) {
      return 'Subagents are disabled in Agent Desk settings.'
    }
    // Keep list/control tools usable until the runtime goes idle so existing
    // children can still be stopped; the next runtime has no such tools.
  })
}
