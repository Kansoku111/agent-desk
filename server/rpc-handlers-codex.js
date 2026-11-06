// A separate task API keeps Codex sessions out of dsh's ACP/session policies.
export function createCodexHandlers({ codex, teams, paths, mutateSettings }) {
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
  return {
    'codex.models': async () => ({ models: await codex.models({ refresh: true }) }),
    'codex.task.create': async ({ workspace, model, effort, permissionMode }) => {
      teams.guardExecution({ workspace })
      const value = await codex.create({ workspace, model, effort, permissionMode })
      await mutateSettings(candidate => {
        if (value.workspace === paths.myPc || candidate.workspaces.includes(value.workspace)) return false
        candidate.workspaces.unshift(value.workspace)
      })
      return { task: value }
    },
    'codex.task.get': ({ taskId }) => ({ task: task(taskId), turns: codex.turns(taskId), permissions: codex.pendingPermissions(taskId) }),
    'codex.task.send': async ({ taskId, text, images }) => {
      const value = task(taskId)
      if (value.ab || value.team?.childId || (value.team && value.team.role !== 'leader')) throw new Error('この担当はAB・チームの画面から操作してください')
      if (value.team?.role === 'leader' && !codex.running(taskId)) await teams.refreshCodexLeader(taskId)
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
      return { task: await codex.update(taskId, { title, archived, pinned, model, effort, permissionMode }) }
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
  }
}
