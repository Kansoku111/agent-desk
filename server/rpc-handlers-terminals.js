// RPC handlers for the Claude Code task terminals and the agent teams that run
// on them (see index.js).
import { attachmentPath } from './attachments.js'

/** Handlers for terminals and teams; index.js merges them into the request table. */
export function createTerminalHandlers({ paths, getSettings, saveSettings, broadcast, terminals, teams, agents }) {
  return {
    // Claude Code tasks. `size` is the viewer's terminal in characters ({ cols, rows }).
    'terminal.create': async ({ workspace, size }) => {
      const terminal = await terminals.create({ workspace, size })
      if (terminal.workspace !== paths.myPc && !getSettings().workspaces.includes(terminal.workspace)) {
        getSettings().workspaces.unshift(terminal.workspace)
        await saveSettings()
        broadcast('settings', { settings: getSettings() })
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
    'terminal.send': ({ terminalId, text }) => {
      terminals.sendMessage(terminalId, text)
    },
    'terminal.resize': ({ terminalId, size, claim }, client) => {
      terminals.resize(terminalId, client, size, claim !== false)
    },
    'terminal.insertFile': ({ terminalId, file }) => {
      const saved = attachmentPath(paths.attachmentsDir, file)
      if (!saved) throw new Error('添付ファイルが見つかりません')
      terminals.insertPath(terminalId, saved)
      // Something other than null: the page takes null as a failure.
      return { inserted: true }
    },
    'terminal.restart': ({ terminalId, size }, client) => ({ terminal: terminals.restart(terminalId, client, size) }),
    // `model` / `effort`: a value, null for Claude Code's own default, or left out to keep the current one.
    'terminal.configure': async ({ terminalId, model, effort }, client) => ({ terminal: await terminals.configure(terminalId, client, { model, effort }) }),
    'terminal.stop': ({ terminalId }) => ({ terminal: terminals.stop(terminalId) }),
    'terminal.update': async ({ terminalId, title, archived }) => ({ terminal: await terminals.update(terminalId, { title, archived }) }),
    // Deleting a team's leader deletes the team with its children.
    'terminal.remove': ({ terminalId }) => {
      const teamId = teams.teamLedBy(terminalId)
      return teamId ? teams.removeTeam(teamId) : terminals.remove(terminalId)
    },

    // Agent teams (TM). `size` is the viewer's terminal, as for terminal.create.
    // `choices`: what the user picked in the start dialog; the next team starts from them.
    'team.create': async ({ workspace, size, choices }) => {
      const result = await teams.create({ workspace, size, choices })
      const folder = result.team.workspace
      if (folder !== paths.myPc && !getSettings().workspaces.includes(folder)) getSettings().workspaces.unshift(folder)
      getSettings().agentTeams = result.team.config
      await saveSettings()
      broadcast('settings', { settings: getSettings() })
      return result
    },
    'team.update': ({ teamId, patch }) => teams.updateConfig(teamId, patch),
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
