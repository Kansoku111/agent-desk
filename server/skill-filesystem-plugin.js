// Extend Harness discovery without changing its parsing, reads or watch lifecycle.
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshBin } from './paths.js'

const requireFromDsh = createRequire(dshBin)
const upstream = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-skill-filesystem')).href)
export const { Config, inject, name } = upstream

export class AgentDeskSkillProvider extends upstream.FileSystemSkillProvider {
  async roots(cwd) {
    const roots = await super.roots(cwd)
    if (!this.includeDefaultRoots) return roots
    const projectRoot = roots.find((root) => root.source === 'project-dsh')?.projectRoot
    // Keep existing .dsh/.agents winners; compatibility roots precede bundled skills.
    for (const [index, directory] of ['.codex', '.claude'].entries()) {
      if (projectRoot) roots.push({
        path: path.join(projectRoot, directory, 'skills'),
        source: 'custom', rank: 210 + index, projectRoot, skipSystem: true,
      })
      roots.push({
        path: path.join(os.homedir(), directory, 'skills'),
        source: 'custom', rank: 510 + index, skipSystem: true,
      })
    }
    return roots
  }
}

export function apply(ctx, config = {}) {
  let provider
  ctx.skills.registerProvider((control) => {
    provider = new AgentDeskSkillProvider(ctx, control, config)
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'Agent Desk skill-filesystem watcher')
  ctx.on('fs/observed', (target, _observation, actor) => {
    if (actor?.name === 'write' || actor?.name === 'edit') provider.observeHostMutation(target.displayPath)
  })
}
