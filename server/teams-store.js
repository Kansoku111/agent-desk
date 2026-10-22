// The saved teams file (teams.json): what a save holds, and how a saved team is
// read back (older saves lack newer fields).
import { teamConfig } from './team-config.js'

/** A file with no teams, for an app that never saved one. */
export const EMPTY_TEAMS = { version: 1, teams: [] }

/** The teams a save holds, checked and filled in. */
export function restoreTeams(saved, getSettings) {
  const teams = []
  for (const team of Array.isArray(saved?.teams) ? saved.teams : []) {
    if (typeof team?.id !== 'string' || typeof team.leaderId !== 'string' || typeof team.secret !== 'string') continue
    team.children = (Array.isArray(team.children) ? team.children : [])
      // Claude children used to be terminal tasks; those are plain Claude Code tasks now.
      .filter((child) => child?.kind === 'thread' || child?.kind === 'agent')
      .map((child) => ({ pending: [], followups: [], reports: [], ...child }))
    team.queue = Array.isArray(team.queue) ? team.queue.filter((item) => item.kind !== 'approval') : []
    team.asks = Array.isArray(team.asks) ? team.asks : []
    team.leaderKind = team.leaderKind === 'thread' ? 'thread' : 'terminal'
    team.config = teamConfig(team.config ?? getSettings())
    teams.push(team)
  }
  return teams
}

/** What to write: the teams, with the reports being handed to the leader at the head of its queue. */
export function saveSnapshot(teams, delivering) {
  return {
    version: 1,
    teams: [...teams].map(({ deliveryFailed: _failed, ...team }) => {
      // Reports being handed to the leader are saved at the head of the queue: if the app stops before the leader took them, they go out again (marked).
      const handing = delivering.get(team.id)?.items ?? []
      return structuredClone(handing.length ? { ...team, queue: [...handing.map((item) => ({ ...item, resent: true })), ...team.queue] } : team)
    }),
  }
}
