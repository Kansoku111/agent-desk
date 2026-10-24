// App state plus the WebSocket connection to the Agent Desk server.
import { useSyncExternalStore } from 'react'
import type {
  AppState, Attachment, ClaudeAuthConfirmation, LoginState, ModelUpdate, PermissionMode, SubagentInfo, TeamSettings, TeamSummary, TerminalSummary, ThreadSummary, Turn,
} from './types'
import { Outbox, readQueues, type QueuedMessage } from './outbox'
import { RpcClient } from './rpc-client'
import { notificationRoute, notificationText, type TaskNotification } from './notification'
export type { QueuedMessage } from './outbox'

type Route = { view: 'home' } | { view: 'thread'; id: string } | { view: 'terminal'; id: string } | { view: 'agent'; id: string } | { view: 'ab'; id: string }
export type SettingsTab = 'accounts' | 'models' | 'teams' | 'personalize' | 'usage' | 'general' | 'remote' | 'about'

interface Toast {
  id: number
  text: string
  tone: 'info' | 'error' | 'success'
}

export interface State {
  /** `revoked`: the server refused this page's token (a new link was made, or the app restarted). */
  connection: 'connecting' | 'open' | 'closed' | 'no-token' | 'revoked'
  server: AppState | null
  turns: Record<string, Turn[]>
  /** The turns of a team's Claude children that were opened, by their session id. */
  agentTurns: Record<string, Turn[]>
  /** Each loaded task's subagents, oldest first. */
  subagents: Record<string, SubagentInfo[]>
  /** Whether the subagent panel shows beside a task that has subagents. */
  subagentPanel: boolean
  /** The subagent whose work the panel shows; null shows the list. */
  subagentFocus: string | null
  /** Whether a team leader shows its children beside it. */
  teamPanel: boolean
  route: Route
  settingsOpen: SettingsTab | null
  projectDialog: boolean
  /** The folder the team start dialog (TM) is open for. */
  teamStart: string | null
  executionStart: string | null
  abStart: string | null
  sidebarOpen: boolean
  toasts: Toast[]
  queued: Record<string, QueuedMessage[]>
  /** New-thread composer choices before a thread exists. */
  draft: { workspace: string | null; model: string | null; effort: string; permissionMode: PermissionMode }
}

const TOKEN_KEY = 'agent-desk-token'
const REMOTE_TOKEN_KEY = 'agent-desk-remote-token'
const ROUTE_KEY = 'agent-desk-route'
const SUBAGENT_PANEL_KEY = 'agent-desk-subagent-panel'
const TEAM_PANEL_KEY = 'agent-desk-team-panel'
const QUEUED_KEY = 'agent-desk-queued'

/** Opened from a phone over remote access; the PC's own window uses 127.0.0.1. */
export const remoteHost = !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)

/** Narrow screens (phones) show the sidebar as an overlay. */
export const isNarrow = () => window.matchMedia('(max-width: 860px)').matches

/** Touch screens: Enter makes a new line, and the keyboard does not pop up on its own. */
export const isTouch = () => window.matchMedia('(pointer: coarse)').matches

function readToken(): string | null {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('t')
  if (remoteHost) return readRemoteToken(url, fromUrl)
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl)
    } catch {
      // Kept in the address instead, so a reload can still connect.
      return fromUrl
    }
    url.searchParams.delete('t')
    url.searchParams.delete('port')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return fromUrl
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/**
 * A phone's token lasts until the PC makes a new link, so it stays in the
 * address: a bookmark or a home-screen icon made from this page keeps
 * working (iOS home-screen apps do not share storage with Safari).
 */
function readRemoteToken(url: URL, fromUrl: string | null) {
  if (fromUrl) {
    try {
      localStorage.setItem(REMOTE_TOKEN_KEY, fromUrl)
    } catch {}
    return fromUrl
  }
  let saved: string | null = null
  try {
    saved = localStorage.getItem(REMOTE_TOKEN_KEY)
  } catch {}
  if (saved) {
    url.searchParams.set('t', saved)
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
  return saved
}

function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    if (remoteHost) localStorage.removeItem(REMOTE_TOKEN_KEY)
  } catch {}
}

function readRoute(): Route {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null')
    if (['thread', 'terminal', 'agent', 'ab'].includes(saved?.view) && typeof saved.id === 'string') return saved
  } catch {}
  return { view: 'home' }
}

/** Follow-ups survive a reload (an app restart after a dsh update reloads the page). */
function readQueued(): Record<string, QueuedMessage[]> {
  try {
    return readQueues(sessionStorage.getItem(QUEUED_KEY))
  } catch {}
  return {}
}

export const token = readToken()

/** The panel opens by default beside the task, but not over it on a phone. */
function readSubagentPanel() {
  if (isNarrow()) return false
  try {
    const saved = localStorage.getItem(SUBAGENT_PANEL_KEY)
    if (saved === 'open' || saved === 'closed') return saved === 'open'
  } catch {}
  return !isNarrow()
}

function readTeamPanel() {
  if (isNarrow()) return false
  try {
    return localStorage.getItem(TEAM_PANEL_KEY) !== 'closed'
  } catch {}
  return true
}

let state: State = {
  connection: token ? 'connecting' : 'no-token',
  server: null,
  turns: {},
  agentTurns: {},
  subagents: {},
  subagentPanel: readSubagentPanel(),
  subagentFocus: null,
  teamPanel: readTeamPanel(),
  route: readRoute(),
  settingsOpen: null,
  projectDialog: false,
  teamStart: null,
  executionStart: null,
  abStart: null,
  sidebarOpen: !isNarrow(),
  toasts: [],
  queued: readQueued(),
  draft: { workspace: null, model: null, effort: 'medium', permissionMode: 'workspace-write' },
}

const listeners = new Set<() => void>()

export function getState() {
  return state
}

export function setState(patch: Partial<State> | ((current: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStore<T>(selector: (current: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

/** The UI build this page was loaded with (learned from the first hello). */
let loadedBuild: string | null = null

function updateServer(patch: Partial<AppState>) {
  setState((current) => (current.server ? { server: { ...current.server, ...patch } } : {}))
}

// ------------------------------------------------------------------ toasts

let toastSeq = 0
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++toastSeq
  setState((current) => ({ toasts: [...current.toasts, { id, text, tone }].slice(-4) }))
  setTimeout(() => setState((current) => ({ toasts: current.toasts.filter((entry) => entry.id !== id) })), tone === 'error' ? 7000 : 3500)
}

// ------------------------------------------------------------------ connection

let socket: WebSocket | null = null
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
const rpc = new RpcClient()

export function request<T = any>(type: string, params: Record<string, unknown> = {}): Promise<T> {
  return rpc.request<T>(type, params)
}

/** Like `request`, but reports failures as a toast and resolves to null. */
export async function act<T = any>(type: string, params: Record<string, unknown> = {}): Promise<T | null> {
  try {
    return await request<T>(type, params)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // This page is newer than the server, which still runs the code from before an update.
    toast(message.startsWith('unknown request:') ? 'Agent Desk が古いまま動いています。Agent Desk を起動し直すと使えます' : message, 'error')
    return null
  }
}

/** True when the server answers but refuses the token; false when it cannot be reached. */
async function tokenRefused() {
  try {
    const response = await fetch(`/api/auth?t=${encodeURIComponent(token ?? '')}`, { cache: 'no-store' })
    return response.status === 403
  } catch {
    return false
  }
}

export function connect() {
  if (!token || (socket && socket.readyState < WebSocket.CLOSING)) return
  clearTimeout(retryTimer)
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${protocol}://${location.host}/ws?t=${encodeURIComponent(token)}`)
  socket = ws
  rpc.attach(ws)
  let opened = false
  setState({ connection: 'connecting' })
  ws.onmessage = (message) => {
    if (socket !== ws) return
    let frame
    try { frame = JSON.parse(message.data) } catch { return }
    if (!frame || typeof frame !== 'object') return
    if (!rpc.receive(frame, ws)) handleFrame(frame)
  }
  ws.onopen = () => {
    if (socket !== ws) return
    retry = 0
    opened = true
  }
  ws.onclose = async () => {
    rpc.detach(ws)
    if (socket !== ws) return
    // Refused before opening: retrying cannot help once the token is no longer valid.
    const refused = !opened && await tokenRefused()
    if (socket !== ws) return
    if (refused) {
      forgetToken()
      setState({ connection: 'revoked' })
      return
    }
    setState({ connection: 'closed' })
    retry = Math.min(retry + 1, 6)
    retryTimer = setTimeout(connect, 400 * 2 ** retry)
  }
}

/** Skips the back-off wait: a phone coming back to the page, or back online, reconnects at once. */
function reconnectNow() {
  if (state.connection !== 'closed' || document.hidden) return
  clearTimeout(retryTimer)
  retry = 0
  connect()
}
document.addEventListener('visibilitychange', reconnectNow)
window.addEventListener('online', reconnectNow)

function upsertThread(thread: ThreadSummary) {
  const server = state.server
  if (!server) return
  const threads = server.threads.filter((entry) => entry.id !== thread.id)
  threads.push(thread)
  threads.sort((a, b) => b.updatedAt - a.updatedAt)
  updateServer({ threads })
}

/** Whether two parsed-JSON values are equal all the way down. */
function sameJson(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/**
 * A turn arrives whole on every update. The items that did not change keep their
 * previous objects, so what renders them (memo) and what was computed from them
 * (tool summaries) can be reused; a turn with nothing changed stays as it was.
 */
function shareTurn(previous: Turn | undefined, next: Turn): Turn {
  if (!previous) return next
  const before = new Map(previous.items.map((item) => [`${item.type}-${item.id}`, item]))
  const items = next.items.map((item) => {
    const old = before.get(`${item.type}-${item.id}`)
    return old && sameJson(old, item) ? old : item
  })
  const shared = { ...next, items }
  if (items.length === previous.items.length && items.every((item, i) => item === previous.items[i]) && sameJson({ ...previous, items: null }, { ...shared, items: null })) return previous
  return shared
}

/** The turns with one turn's speed replaced; the same list when nothing changes. */
function withSpeed(turns: Turn[] | undefined, turnId: string, speed: Turn['outputSpeed'] | null): Turn[] | null {
  const index = turns?.findIndex((turn) => turn.id === turnId) ?? -1
  if (!turns || index < 0) return null
  const turn = turns[index]
  if (sameJson(turn.outputSpeed ?? null, speed)) return null
  const { outputSpeed: _old, ...rest } = turn
  return turns.map((entry, i) => (i === index ? (speed ? { ...rest, outputSpeed: speed } : rest) : entry))
}

function handleFrame(frame: any) {
  switch (frame.event) {
    case 'hello': {
      const server = frame.state as AppState
      // A newer server took over: load its UI instead of talking to it with this one.
      if (loadedBuild && server.app.uiBuild && server.app.uiBuild !== loadedBuild) {
        window.location.reload()
        return
      }
      loadedBuild ??= server.app.uiBuild
      const draft = { ...state.draft }
      draft.workspace ??= server.settings.lastWorkspace ?? server.app.myPc ?? null
      draft.model ??= server.settings.defaultModel
      draft.effort = draft.effort || server.settings.defaultEffort || 'medium'
      if (!state.server) draft.permissionMode = server.settings.defaultPermissionMode ?? draft.permissionMode
      const route = (state.route.view === 'thread' && !server.threads.some((thread) => thread.id === (state.route as { id: string }).id))
        || (state.route.view === 'terminal' && !server.terminals.some((terminal) => terminal.id === (state.route as { id: string }).id))
        || (state.route.view === 'agent' && !teamChildOf(server, state.route.id))
        || (state.route.view === 'ab' && !(server.ab ?? []).some((run) => run.id === (state.route as { id: string }).id))
        ? { view: 'home' as const }
        : state.route
      setState({ server, connection: 'open', draft, route, turns: {}, agentTurns: {}, subagents: {} })
      for (const threadId of Object.keys(state.queued)) {
        if (!server.threads.some((thread) => thread.id === threadId)) forgetQueued(threadId)
      }
      // A turn may have ended while the connection was down, so its `thread` event was missed.
      flushQueues()
      if (route.view === 'thread') void loadThread(route.id)
      if (route.view === 'agent') void loadAgentTurns(route.id)
      announceNewModels(server.modelUpdate)
      for (const listener of helloListeners) listener()
      break
    }
    case 'terminal':
      upsertTerminal(frame.terminal)
      break
    case 'terminalRemoved': {
      const server = state.server
      if (!server) break
      updateServer({ terminals: server.terminals.filter((terminal) => terminal.id !== frame.terminalId) })
      if (state.route.view === 'terminal' && state.route.id === frame.terminalId) navigate({ view: 'home' })
      break
    }
    case 'ab': {
      const runs = state.server?.ab ?? []
      updateServer({ ab: [...runs.filter((run) => run.id !== frame.run.id), frame.run] })
      break
    }
    case 'abRemoved':
      updateServer({ ab: (state.server?.ab ?? []).filter((run) => run.id !== frame.id) })
      if (state.route.view === 'ab' && state.route.id === frame.id) navigate({ view: 'home' })
      break
    case 'team':
      upsertTeam(frame.team)
      break
    case 'teamRemoved': {
      const server = state.server
      if (server) updateServer({ teams: (server.teams ?? []).filter((team) => team.id !== frame.teamId) })
      if (state.route.view === 'agent' && state.server && !teamChildOf(state.server, state.route.id)) navigate({ view: 'home' })
      break
    }
    case 'agentTurn': {
      const turns = state.agentTurns[frame.id]
      if (!turns) break
      const index = turns.findIndex((turn) => turn.id === frame.turn.id)
      const turn = shareTurn(turns[index], frame.turn)
      if (index >= 0 && turn === turns[index]) break
      const next = index >= 0 ? turns.map((entry, i) => (i === index ? turn : entry)) : [...turns, turn]
      setState({ agentTurns: { ...state.agentTurns, [frame.id]: next } })
      break
    }
    case 'agentTurnSpeed': {
      const next = withSpeed(state.agentTurns[frame.id], frame.turnId, frame.speed)
      if (next) setState({ agentTurns: { ...state.agentTurns, [frame.id]: next } })
      break
    }
    case 'turnSpeed': {
      const next = withSpeed(state.turns[frame.threadId], frame.turnId, frame.speed)
      if (next) setState({ turns: { ...state.turns, [frame.threadId]: next } })
      break
    }
    case 'termData':
    case 'termReset':
    case 'termSize':
      terminalSinks.get(frame.terminalId)?.(frame)
      break
    case 'thread':
      upsertThread(frame.thread)
      maybeFlushQueue(frame.thread)
      break
    case 'removed': {
      const server = state.server
      if (!server) break
      updateServer({ threads: server.threads.filter((thread) => thread.id !== frame.threadId) })
      forgetQueued(frame.threadId)
      if (state.route.view === 'thread' && state.route.id === frame.threadId) navigate({ view: 'home' })
      break
    }
    case 'turn': {
      const turns = state.turns[frame.threadId]
      if (!turns) break
      const index = turns.findIndex((turn) => turn.id === frame.turn.id)
      const turn = shareTurn(turns[index], frame.turn)
      if (index >= 0 && turn === turns[index]) break
      const next = index >= 0 ? turns.map((entry, i) => (i === index ? turn : entry)) : [...turns, turn]
      setState({ turns: { ...state.turns, [frame.threadId]: next } })
      break
    }
    case 'subagent': {
      // Only tasks whose list was loaded; another task loads its whole list when opened.
      const list = state.subagents[frame.threadId]
      if (!list) break
      const subagent = frame.subagent as SubagentInfo
      const next = list.some((entry) => entry.id === subagent.id)
        ? list.map((entry) => (entry.id === subagent.id ? subagent : entry))
        : [...list, subagent]
      setState({ subagents: { ...state.subagents, [frame.threadId]: next } })
      break
    }
    case 'catalog':
      updateServer({ catalog: frame.catalog })
      break
    case 'fastModels':
      updateServer({ fastModels: frame.fastModels })
      break
    case 'accounts':
      updateServer({ accounts: frame.accounts })
      break
    case 'chatgptUsage':
      updateServer({ chatgptUsage: frame.usage })
      break
    case 'claudeLimits':
      updateServer({ claudeLimits: frame.limits })
      break
    case 'usage':
      updateServer({ usage: frame.usage })
      break
    case 'settings':
      updateServer({ settings: frame.settings })
      break
    case 'runtime':
      updateServer({ runtime: frame.runtime })
      break
    case 'remoteAccess':
      updateServer({ remoteAccess: frame.remoteAccess })
      break
    case 'updates':
      updateServer({ updates: frame.updates })
      break
    case 'modelUpdate':
      updateServer({ modelUpdate: frame.modelUpdate })
      announceNewModels(frame.modelUpdate)
      break
    case 'login': {
      const login = frame.login as LoginState
      updateServer({ login })
      if (login.phase === 'done') toast('ChatGPT にサインインしました', 'success')
      break
    }
    case 'codexLogin': {
      const codexLogin = frame.codexLogin as LoginState
      updateServer({ codexLogin })
      if (codexLogin.phase === 'done') toast('画像生成と利用上限（Codex）にサインインしました', 'success')
      break
    }
    case 'notify':
      notify(frame)
      break
  }
}

/** Tells about newly added models once per browser, also when they arrived while no window was open. */
const MODELS_SEEN_KEY = 'agent-desk-models-seen'
function announceNewModels(update: ModelUpdate | undefined) {
  const added = update?.lastAdded
  if (!added?.models.length || Date.now() - added.at > 7 * 24 * 60 * 60 * 1000) return
  let seen: string | null = null
  try {
    seen = localStorage.getItem(MODELS_SEEN_KEY)
  } catch {}
  if (seen === String(added.at)) return
  try {
    localStorage.setItem(MODELS_SEEN_KEY, String(added.at))
  } catch {}
  const names = added.models.map((model) => model.name).join('、')
  const busy = state.server?.threads.some((thread) => thread.status === 'running')
  toast(`新しいモデルを追加しました: ${names}${busy ? '（作業中のタスクが終わるとモデルの一覧に出ます）' : ''}`, 'success')
}

function notify(frame: TaskNotification) {
  const route = notificationRoute(frame)
  const viewing = state.route.view === route.view && state.route.id === frame.threadId && !document.hidden
  if (viewing) return
  const text = notificationText(frame)
  if (document.hidden && state.server?.settings.notifications && 'Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification('Agent Desk', { body: text, tag: frame.threadId })
    notification.onclick = () => {
      window.focus()
      navigate(route)
    }
  }
  if (!document.hidden) toast(text, frame.status === 'error' ? 'error' : 'info')
}

// ------------------------------------------------------------------ Claude Code tasks

/**
 * What an open terminal receives: output, a new start of Claude Code (clear the
 * screen), or the size another window or the phone gave the terminal.
 */
type TerminalFrame =
  | { event: 'termData'; data: string }
  | { event: 'termReset' }
  | { event: 'termSize'; size: { cols: number; rows: number } }

const terminalSinks = new Map<string, (frame: TerminalFrame) => void>()
const helloListeners = new Set<() => void>()

/** Receives one task's terminal output until the returned function is called. */
export function onTerminalData(id: string, sink: (frame: TerminalFrame) => void) {
  terminalSinks.set(id, sink)
  return () => {
    if (terminalSinks.get(id) === sink) terminalSinks.delete(id)
  }
}

/** Runs after every (re)connection, once the server's state arrived: open terminals attach again. */
export function onHello(listener: () => void) {
  helloListeners.add(listener)
  return () => {
    helloListeners.delete(listener)
  }
}

function upsertTerminal(terminal: TerminalSummary) {
  const server = state.server
  if (!server) return
  const terminals = server.terminals.filter((entry) => entry.id !== terminal.id)
  terminals.push(terminal)
  terminals.sort((a, b) => b.updatedAt - a.updatedAt)
  updateServer({ terminals })
}

/** Starts Claude Code in a project (or My PC) and shows it. */
export async function startTerminal(workspace: string) {
  const result = await act<{ terminal: TerminalSummary }>('terminal.create', { workspace })
  if (!result) return false
  upsertTerminal(result.terminal)
  navigate({ view: 'terminal', id: result.terminal.id })
  return true
}

// ------------------------------------------------------------------ agent teams

function upsertTeam(team: TeamSummary) {
  const server = state.server
  if (!server) return
  updateServer({ teams: [...(server.teams ?? []).filter((entry) => entry.id !== team.id), team] })
}

/** Starts an agent team in a project (or My PC): its Claude Code leader opens to talk to. */
/** Starts a team in the folder with the choices of the start dialog; its leader (Claude Code or GPT) opens. */
export async function startTeam(workspace: string, choices: TeamSettings, authConfirmation?: ClaudeAuthConfirmation, execution?: { leaderModel?: string }) {
  const result = await act<{ team: TeamSummary; terminal?: TerminalSummary; thread?: ThreadSummary }>('team.create', { workspace, choices, authConfirmation, execution })
  if (!result) return false
  upsertTeam(result.team)
  if (result.thread) {
    upsertThread(result.thread)
    navigate({ view: 'thread', id: result.thread.id })
  } else if (result.terminal) {
    upsertTerminal(result.terminal)
    navigate({ view: 'terminal', id: result.terminal.id })
  }
  return true
}

/** Shows or hides the team panel beside a leader, and remembers the choice. */
export function setTeamPanel(open: boolean) {
  setState({ teamPanel: open })
  try {
    localStorage.setItem(TEAM_PANEL_KEY, open ? 'open' : 'closed')
  } catch {}
}

/** The task of a team's child: its dsh task, or the view of its headless Claude Code. */
export function openTeamChild(child: { kind: 'thread' | 'agent'; taskId: string | null }) {
  if (child.taskId) navigate({ view: child.kind, id: child.taskId })
}

/** The team and child a Claude child's session belongs to. */
export function teamChildOf(server: AppState, taskId: string) {
  for (const team of server.teams ?? []) {
    const child = team.children.find((entry) => entry.kind === 'agent' && entry.taskId === taskId)
    if (child) return { team, child }
  }
  return null
}

export async function loadAgentTurns(taskId: string) {
  const result = await act<{ turns: Turn[] }>('team.childTurns', { taskId })
  if (result) setState((current) => ({ agentTurns: { ...current.agentTurns, [taskId]: result.turns } }))
}

// ------------------------------------------------------------------ navigation and threads

export function navigate(route: Route) {
  // On a phone the sidebar covers the page; choosing where to go closes it.
  setState(isNarrow() ? { route, sidebarOpen: false } : { route })
  try {
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify(route))
  } catch {}
  if (route.view === 'thread' && !state.turns[route.id]) void loadThread(route.id)
  else if (route.view === 'thread' && !state.subagents[route.id]) void loadSubagents(route.id)
  else if (route.view === 'agent') void loadAgentTurns(route.id)
}

export async function loadThread(id: string) {
  const result = await act<{ turns: Turn[] }>('thread.get', { threadId: id })
  if (result) setState((current) => ({ turns: { ...current.turns, [id]: result.turns } }))
  void loadSubagents(id)
}

export async function loadSubagents(id: string) {
  // Quietly: the panel is extra, and a task without a session has no subagents.
  try {
    const result = await request<{ subagents: SubagentInfo[] }>('subagents.list', { threadId: id })
    setState((current) => ({ subagents: { ...current.subagents, [id]: result.subagents } }))
  } catch {}
}

/** Shows or hides the subagent panel, and remembers the choice. */
export function setSubagentPanel(open: boolean, focus: string | null = getState().subagentFocus) {
  setState({ subagentPanel: open, subagentFocus: focus })
  try {
    localStorage.setItem(SUBAGENT_PANEL_KEY, open ? 'open' : 'closed')
  } catch {}
}

export function attachmentUrl(file: string) {
  return `/attachments/${file}?t=${encodeURIComponent(token ?? '')}`
}

function wire(images: Attachment[]) {
  return images.map(({ file, mimeType, name }) => ({ file, mimeType, name }))
}

export async function startThread(text: string, images: Attachment[]) {
  const { draft } = state
  if (!draft.workspace) {
    toast('ワークスペースを選択してください', 'error')
    return false
  }
  const result = await act<{ thread: ThreadSummary }>('thread.create', {
    workspace: draft.workspace,
    model: draft.model,
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    text,
    images: wire(images),
  })
  if (!result) return false
  upsertThread(result.thread)
  setState((current) => ({ turns: { ...current.turns, [result.thread.id]: current.turns[result.thread.id] ?? [] } }))
  navigate({ view: 'thread', id: result.thread.id })
  void loadThread(result.thread.id)
  return true
}

const outbox = new Outbox({
  initial: state.queued,
  persist: (queued) => {
    try { sessionStorage.setItem(QUEUED_KEY, JSON.stringify(queued)) } catch {
      throw new Error('送信待ちのメッセージを保存できません。ブラウザの空き容量・ストレージ設定を確認してください')
    }
  },
  changed: (queued) => setState({ queued }),
  request: (type, params) => rpc.request(type, params, 30_000),
  thread: (id) => state.server?.threads.find((thread) => thread.id === id),
  ready: () => state.connection === 'open',
  report: (message) => toast(message, 'error'),
})

export async function sendMessage(threadId: string, text: string, images: Attachment[]) {
  const thread = state.server?.threads.find((entry) => entry.id === threadId)
  if (!thread) return false
  try {
    // Keep the composer text unless the durable outbox accepted it. A manual
    // message after a failed turn starts recovery before its old follow-ups.
    outbox.enqueue(threadId, text, images, thread.status === 'error')
    void outbox.flush(threadId, thread.status === 'error')
    return true
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    return false
  }
}

export async function steerQueued(threadId: string, index: number) {
  const message = state.queued[threadId]?.[index]
  if (message) await outbox.steer(threadId, message.id)
}

export async function retryQueued(threadId: string, index: number) {
  const message = state.queued[threadId]?.[index]
  if (message) await outbox.retry(threadId, message.id)
}

export function removeQueued(threadId: string, index: number) {
  const message = state.queued[threadId]?.[index]
  if (!message) return
  if (message.phase === 'uncertain' && !window.confirm('送信済みの可能性があります。この一覧から外しても、エージェントへの依頼は取り消されません。一覧から外しますか？')) return
  try { outbox.remove(threadId, message.id) } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function forgetQueued(threadId: string) {
  try { outbox.forget(threadId) } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

function flushQueues() {
  for (const thread of state.server?.threads ?? []) maybeFlushQueue(thread)
}

function maybeFlushQueue(thread: ThreadSummary) {
  void outbox.flush(thread.id)
}

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Whether the model sees this attachment as a picture (other files reach it as a path). */
export function isImageAttachment(attachment: { mimeType: string; file: string }) {
  return IMAGE_MIME_TYPES.has(attachment.mimeType) && !attachment.file.includes('/')
}

export async function uploadAttachment(file: File): Promise<Attachment | null> {
  const label = file.name || 'ファイル'
  if (file.size > 10 * 1024 * 1024) {
    toast(`${label}: ファイルは 10MB 以下にしてください`, 'error')
    return null
  }
  let data: string
  try {
    data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  } catch {
    // A dropped folder arrives as a File that cannot be read.
    toast(`${label} を読み込めませんでした（フォルダーは添付できません）`, 'error')
    return null
  }
  const saved = await act<{ file: string; mimeType: string; name: string }>('attachment.add', {
    name: file.name || (IMAGE_MIME_TYPES.has(file.type) ? 'image' : 'file'),
    mimeType: file.type,
    data,
  })
  if (!saved) return null
  return { ...saved, previewUrl: isImageAttachment(saved) ? attachmentUrl(saved.file) : '' }
}

export function openExternal(url: string) {
  // A phone opens links itself; the PC's window asks the server to use the PC's browser.
  if (state.server?.app.remote) window.open(url, '_blank', 'noopener,noreferrer')
  else void act('system.openUrl', { url })
}

/** Whether this page is a phone using remote access (PC-only actions are hidden). */
export function useRemote() {
  return useStore((current) => current.server?.app.remote ?? remoteHost)
}
