// RPC handlers for the Claude Code task terminals and the agent teams that run
// on them (see index.js).
import { attachmentPath } from './attachments.js'

/** Handlers for terminals and teams; index.js merges them into the request table. */
export function createTerminalHandlers({ paths, mutateSettings, terminals, teams, agents }) {
  return {
    // Claude Code tasks. `size` is the viewer's terminal in characters ({ cols, rows }).
    'terminal.create': async ({ workspace, size }) => {
      const terminal = await terminals.create({ workspace, size })
      if (terminal.workspace !== paths.myPc) {
        await mutateSettings(candidate => {
          if (candidate.workspaces.includes(terminal.workspace)) return false
          candidate.workspaces.unshift(terminal.workspace)
        })
      }
      return { terminal }
    },
    'terminal.attach': ({ terminalId, size }, client) => terminals.attach(terminalId, client, size),
    'terminal.detach': ({ terminalId }, client) => {
      terminals.detach(terminalId, client)
    },
    'terminal.input': ({ terminalId, data, reply }, client) => {
      terminals.input(terminalId, client, data, reply === true)
    },
    'terminal.interrupt': ({ terminalId }, client) => {
      terminals.interrupt(terminalId, client)
    },
    'terminal.conversation': ({ terminalId, epoch, since }) => terminals.conversation(terminalId, { epoch, since }),
    'terminal.dialog': async ({ terminalId }) => ({ dialog: await terminals.dialog(terminalId) }),
    'terminal.choose': ({ terminalId, key, label }) => terminals.choose(terminalId, key, label),
    'terminal.send': async ({ terminalId, text }) => {
      await terminals.sendMessage(terminalId, text)
      // Something other than null: the page takes null as a failure.
      return { sent: true }
    },
    'terminal.resize': ({ terminalId, size, claim }, client) => {
      terminals.resize(terminalId, client, size, claim !== false)
    },
    'terminal.insertFile': async ({ terminalId, file }) => {
      const saved = attachmentPath(paths.attachmentsDir, file)
      if (!saved) throw new Error('添付ファイルが見つかりません')
      await terminals.insertPath(terminalId, saved)
      // Something other than null: the page takes null as a failure.
      return { inserted: true }
    },
    'terminal.restart': async ({ terminalId, size }, client) => ({ terminal: await terminals.restart(terminalId, client, size) }),
    // `model` / `effort`: a value, null for Claude Code's own default, or left out to keep the current one.
    'terminal.configure': async ({ terminalId, model, effort }, client) => ({ terminal: await terminals.configure(terminalId, client, { model, effort }) }),
    'terminal.stop': ({ terminalId }) => ({ terminal: terminals.stop(terminalId) }),
    'terminal.update': async ({ terminalId, title, archived, pinned }) => ({ terminal: await terminals.update(terminalId, { title, archived, pinned }) }),
    // Deleting a team's leader deletes the team with its children.
    'terminal.remove': ({ terminalId }) => {
      const teamId = teams.teamLedBy(terminalId)
      return teamId ? teams.removeTeam(teamId) : terminals.remove(terminalId)
    },

    // Agent teams (TM). `size` is the viewer's terminal, as for terminal.create.
    // `choices`: what the user picked in the start dialog; the next team starts from them.
    'team.claudeAuth': (input) => teams.inspectClaudeAuth(input),
    'execution.models': async () => ({ models: await teams.execution.modelSelection() }),
    'execution.setModels': async ({ models, onlyIfUnset }) => ({ models: await teams.execution.configureModels(models, onlyIfUnset === true) }),
    'execution.checks': ({ workspace }) => teams.executionChecks(workspace),
    'execution.configure': ({ workspace, checks }) => teams.configureExecution(workspace, checks),
    'team.create': async ({ workspace, size, choices, authConfirmation, execution }) => {
      const result = await teams.create({ workspace, size, choices, authConfirmation, execution })
      const folder = result.team.workspace
      await mutateSettings(candidate => {
        if (folder !== paths.myPc && !candidate.workspaces.includes(folder)) candidate.workspaces.unshift(folder)
        if (!execution) candidate.agentTeams = { ...structuredClone(result.team.config), defaultModelMode: candidate.agentTeams.defaultModelMode }
      })
      return result
    },
    'team.update': ({ teamId, patch, authConfirmation }) => teams.updateConfig(teamId, patch, authConfirmation),
    'team.approve': ({ teamId, approvalId, allow }) => teams.approveById(teamId, approvalId, allow === true),
    'team.dismissAsk': ({ teamId, askId }) => teams.dismissAsk(teamId, askId),
    'team.deliver': ({ teamId }) => teams.retryDelivery(teamId),
    // A Claude child's own view: its turns, a message from the user, stopping its turn.
    'team.childTurns': ({ taskId }) => ({ turns: agents.turns(String(taskId ?? '')) ?? [] }),
    'team.message': ({ teamId, childId, text }) => teams.messageChild(teamId, childId, text),
    'team.steerFollowup': ({ teamId, childId, followupId }) => teams.steerFollowup(teamId, childId, followupId),
    'team.dropFollowup': ({ teamId, childId, followupId }) => teams.dropFollowup(teamId, childId, followupId),
    'team.stopChild': ({ teamId, childId }) => teams.stopChild(teamId, childId),
    'team.stopAll': ({ teamId }) => teams.stopAll(teamId),
  }
}
