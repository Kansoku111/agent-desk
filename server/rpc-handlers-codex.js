// A separate task API keeps Codex sessions out of dsh's ACP/session policies.
export function createCodexHandlers({ codex, teams, paths, getSettings, mutateSettings, subagentMcp = () => null }) {
  function task(taskId) {
    const value = codex.get(taskId)
    if (!value) throw new Error('Codex タスクが見つかりません')
    return value
  }
  function independent(taskId) {
    const value = task(taskId)
    if (value.ab || value.team) throw new Error('この担当はAB・チームの画面から操作してください')
    return value
  }
  function remember(candidate, value, { model = false, permissionMode = false } = {}) {
    const previous = candidate.codexDefaults
    const next = previous ? { ...previous } : { model: value.model, effort: value.effort, permissionMode: value.permissionMode }
    if (model) { next.model = value.model; next.effort = value.effort }
    if (permissionMode) next.permissionMode = value.permissionMode
    if (previous && ['model', 'effort', 'permissionMode'].every(key => previous[key] === next[key])) return false
    candidate.codexDefaults = next
    return true
  }
  return {
    'codex.models': async () => ({ models: await codex.models({ refresh: true }) }),
    'codex.task.create': async ({ workspace, model, effort, permissionMode }) => {
      teams.guardExecution({ workspace })
      const defaults = getSettings().codexDefaults ?? {}
      const sameModel = model === undefined || model === defaults.model
      const value = await codex.create({ workspace,
        model: model === undefined ? defaults.model : model,
        effort: effort === undefined && sameModel ? defaults.effort : effort,
        permissionMode: permissionMode === undefined ? defaults.permissionMode : permissionMode,
      })
      await mutateSettings(candidate => {
        // Inheriting settings must not overwrite a newer choice made while creation was pending.
        const changed = remember(candidate, value, { model: model !== undefined || effort !== undefined, permissionMode: permissionMode !== undefined })
        if (value.workspace === paths.myPc || candidate.workspaces.includes(value.workspace)) return changed
        candidate.workspaces.unshift(value.workspace)
      })
      return { task: value }
    },
    'codex.task.get': ({ taskId }) => ({ task: task(taskId), turns: codex.turns(taskId), permissions: codex.pendingPermissions(taskId) }),
    'codex.task.send': async ({ taskId, text, images }) => {
      const value = task(taskId)
      if (value.ab || value.team?.childId || (value.team && value.team.role !== 'leader')) throw new Error('この担当はAB・チームの画面から操作してください')
      if (value.team?.role === 'leader' && !codex.running(taskId)) await teams.refreshCodexLeader(taskId)
      // An ordinary task's only MCP server is its subagent bridge, so follow the settings as of this message.
      const mcpServers = !value.team && !codex.running(taskId) ? subagentMcp(value) : null
      if (mcpServers) await codex.update(taskId, { mcpServers })
      await codex.send(taskId, { text, images })
      return { sent: true }
    },
    'codex.task.stop': async ({ taskId }) => {
      const value = task(taskId)
      if (value.ab || value.team?.childId) throw new Error('この担当はAB・チームの画面から停止してください')
      return { task: await codex.stop(taskId) }
    },
    'codex.task.update': async ({ taskId, title, archived, pinned, model, effort, permissionMode }) => {
      const value = task(taskId)
      if (value.ab || value.team?.childId || (value.team && value.team.role !== 'leader')) throw new Error('AB・チームの担当設定はここでは変更できません')
      if (value.team && [model, effort, permissionMode].some(entry => entry !== undefined)) throw new Error('チームの実行設定はチーム設定から変更してください')
      const updated = await codex.update(taskId, { title, archived, pinned, model, effort, permissionMode })
      if (!value.team && [model, effort, permissionMode].some(entry => entry !== undefined)) {
        await mutateSettings(candidate => remember(candidate, updated, { model: model !== undefined || effort !== undefined, permissionMode: permissionMode !== undefined }))
      }
      return { task: updated }
    },
    'codex.task.remove': async ({ taskId }) => {
      const value = task(taskId)
      if (value.team?.role === 'leader') { await teams.removeTeam(value.team.id); return { removed: true } }
      independent(taskId)
      await codex.remove(taskId)
      return { removed: true }
    },
    'codex.task.permissions': ({ taskId }) => { task(taskId); return { permissions: codex.pendingPermissions(taskId) } },
    'codex.task.respond': ({ taskId, requestId, decision }) => {
      task(taskId)
      codex.respondPermission(taskId, requestId, decision)
      return { accepted: true }
    },
    'codex.task.answer': ({ taskId, requestId, answers }) => {
      task(taskId)
      codex.respondUserInput(taskId, requestId, answers)
      return { accepted: true }
    },
  }
}
