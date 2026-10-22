// Agent teams ("TM"): the user talks to a "leader" (Claude Code in a terminal,
// or GPT as a dsh task), which hands work to "child" agents with the agent-team MCP tools (team-mcp.js) and
// audits what they report. A GPT child is an ordinary dsh task on the ChatGPT
// subscription; a Claude child is Claude Code run headless (claude-runner.js)
// on the Claude subscription, so neither touches an API key. Reports reach the
// leader one at a time, in the order the children finish, when it is idle (typed into
// a Claude leader's terminal, sent to a GPT leader as a message): between
// reports the leader sleeps and spends nothing.
//
// Only a team's leader gets the MCP server (claude --mcp-config, or its dsh
// session's MCP servers), so tasks outside a team carry no extra tools or
// instructions.
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from './json-file.js'
import { sameToken } from './remote.js'
import { mergeTeamConfig, PROVIDER_NAMES, teamConfig, TEAM_PROVIDERS, TEAM_TIERS } from './team-config.js'
import { childTurnArgs, leaderLaunch, leaderMcpServer } from './teams-launch.js'
import { CATALOG_PROVIDER, childPrompt, clip, describeTool, modelName, oneLine, PREFIX, tierLines } from './teams-prompts.js'
import { markOf, reportMessage } from './teams-report.js'
import { EMPTY_TEAMS, restoreTeams, saveSnapshot } from './teams-store.js'

const mcpScript = fileURLToPath(new URL('./team-mcp.js', import.meta.url))

export { MCP_SERVER } from './teams-launch.js'
export { childPrompt, describeTool, leaderPrompt, PREFIX } from './teams-prompts.js'

/**
 * How much of a report the leader is shown; read_report gives all of it. Kept
 * short: Claude Code can take a minute or more to take in a long paste.
 */
export const REPORT_PREVIEW = 1000
const REPORT_KEEP = 40_000
const REPORTS_KEPT = 6
const ASKS_KEPT = 20
/** Someone typed into the leader this recently: a report waits, so it does not land in their sentence. */
export const TYPING_QUIET_MS = 4000
/** A pasted message Claude Code has not started on: Enter is pressed once more after this... */
export const DELIVERY_CHECK_MS = 20_000
/** ...and it is given up this much later. A leader that still takes it after that does not get it again (#onLeaderHook). */
export const DELIVERY_GIVE_UP_MS = 120_000
/** How long a GPT child's approval waits for the leader before the user hears of it. */
export const APPROVAL_WAIT_MS = 840_000
/**
 * A leader that has looked busy this long with reports waiting gets its
 * conversation file checked: a turn that ended without its Stop hook (a hook
 * that failed to run) would otherwise hold the reports back for good.
 */
export const LEADER_SETTLE_MS = 60_000
const RETRY_MS = 1000
const providerList = (providers) => providers.map((provider) => `"${provider}"`).join(' / ')
const TIER_LABEL = { low: '低', mid: '中' }
const STATE_LABEL = {
  running: '作業中', idle: '待機中', approval: '承認待ち', error: 'エラー', stopped: '停止中', closed: '終了', removed: '削除済み',
}

export class TeamManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file  the saved teams
   * @param {string} options.dir  per-team files (MCP config, prompts, messages)
   * @param {import('./threads.js').ThreadManager} options.threads
   * @param {import('./terminals.js').TerminalManager} options.terminals  the leaders
   * @param {import('./claude-runner.js').ClaudeRunner} options.agents  the Claude children
   * @param {{ data: { models: object[] } }} options.catalog
   * @param {() => object} options.getSettings  the saved `agentTeams` settings: the values a new team starts from
   * @param {() => string} options.apiUrl  where team-mcp.js calls (POST /api/team)
   */
  constructor({
    file, dir, threads, terminals, agents, catalog, getSettings, apiUrl,
    node = process.execPath, script = mcpScript, log = () => {}, now = Date.now,
  }) {
    super()
    this.file = file
    this.dir = dir
    this.threads = threads
    this.terminals = terminals
    this.agents = agents
    this.catalog = catalog
    this.getSettings = getSettings
    this.apiUrl = apiUrl
    this.node = node
    this.script = script
    this.log = log
    this.now = now
    /** @type {Map<string, object>} saved teams by id */
    this.teams = new Map()
    /** Approvals a GPT child waits for: { id, teamId, childId, taskId, requestId, tool, at, timer }. */
    this.approvals = new Map()
    /** A message typed into a leader that Claude Code has not taken yet, by team. */
    this.delivering = new Map()
    this.retries = new Map()
    /** GPT children whose turn was stopped for starting a Claude (API-billed) subagent. */
    this.apiStopped = new Set()
    /** Children the user stopped with "全停止": the leader is told it was the user, and not to go on by itself. */
    this.userStopped = new Set()
    this.writes = Promise.resolve()

    threads.on('thread', (thread) => this.#onThread(thread))
    threads.on('turn-finished', (info) => this.#onThreadFinished(info))
    threads.on('approval-needed', (info) => this.#onThreadApproval(info))
    threads.on('removed', ({ threadId }) => this.#onTaskRemoved(threadId))
    terminals.on('terminal', (summary) => this.#onTerminal(summary))
    terminals.on('removed', ({ terminalId }) => this.#onTaskRemoved(terminalId))
    terminals.on('hook', (info) => this.#onLeaderHook(info))
    agents.on('session', (session) => this.#onAgent(session))
    agents.on('finished', (info) => this.#onAgentFinished(info))
    agents.on('removed', ({ id }) => this.#onTaskRemoved(id))
  }

  /**
   * A team's own settings, chosen when it started (and changed in its panel
   * since); a team saved by an older version has the saved settings.
   */
  config(team) {
    return teamConfig(team?.config ?? this.getSettings())
  }

  // ---------------------------------------------------------------- storage

  async load() {
    const saved = await readJson(this.file, EMPTY_TEAMS)
    for (const team of restoreTeams(saved, this.getSettings)) this.teams.set(team.id, team)
    return this
  }

  #save() {
    const snapshot = saveSnapshot(this.teams.values(), this.delivering)
    this.writes = this.writes.then(() => writeJson(this.file, snapshot)).catch((error) => this.log('teams:', error.message))
    return this.writes
  }

  /**
   * Picks up after the app started (the server is listening by now): children
   * whose work the restart cut off report it, and waiting reports go out.
   */
  start() {
    for (const team of this.teams.values()) {
      for (const child of team.children) {
        if (!child.awaiting || child.closed || this.#childBusy(child)) continue
        child.awaiting = false
        this.#report(team, child, 'error', 'Agent Desk が再起動したため、作業が途中で止まりました。続けるなら send で「続けて」と送ってください（それまでの文脈は残っています）。')
      }
      this.#pump(team)
    }
  }

  async stop() {
    for (const approval of this.approvals.values()) clearTimeout(approval.timer)
    for (const timer of this.retries.values()) clearTimeout(timer)
    for (const entry of this.delivering.values()) clearTimeout(entry.timer)
    await this.writes
  }

  // ---------------------------------------------------------------- views

  list() {
    return [...this.teams.values()].map((team) => this.summary(team))
  }

  summary(team) {
    const leader = team.leaderKind === 'thread' ? null : this.terminals.status(team.leaderId)
    let delivery = 'idle'
    if (this.delivering.has(team.id)) delivery = 'delivering'
    else if (team.deliveryFailed) delivery = 'failed'
    else if (team.queue.length && leader?.state === 'exited') delivery = 'leader-stopped'
    else if (team.queue.length) delivery = 'waiting'
    return {
      id: team.id,
      workspace: team.workspace,
      leaderId: team.leaderId,
      leaderKind: team.leaderKind,
      config: this.config(team),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      children: team.children.map((child) => this.#childSummary(child)),
      queue: team.queue.map(({ id, childId, kind, at }) => ({ id, childId, kind, at })),
      delivery,
      approvals: [...this.approvals.values()].filter((entry) => entry.teamId === team.id)
        .map(({ id, childId, tool, at }) => ({ id, childId, tool, at })),
      asks: team.asks.filter((ask) => !ask.done).map(({ id, at, text, childId }) => ({ id, at, text, childId })),
    }
  }

  #childSummary(child) {
    const last = child.reports.at(-1)
    return {
      id: child.id,
      name: child.name,
      title: child.title,
      provider: child.provider,
      tier: child.tier,
      model: child.model,
      modelName: this.#modelName(child),
      effort: child.effort ?? null,
      kind: child.kind,
      taskId: child.taskId,
      state: this.#childState(child),
      closed: Boolean(child.closed),
      awaiting: Boolean(child.awaiting),
      pending: child.pending.length,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      reports: child.reports.length,
      lastReport: last ? { at: last.at, kind: last.kind, text: clip(last.text, 300) } : null,
    }
  }

  #childState(child) {
    if (!child.taskId) return 'running'
    if ([...this.approvals.values()].some((entry) => entry.childId === child.id)) return 'approval'
    if (child.kind === 'thread') {
      const thread = this.threads.threads.get(child.taskId)
      if (!thread) return 'removed'
      if (thread.pendingApproval) return 'approval'
      if (thread.status === 'running') return 'running'
      if (child.closed) return 'closed'
      if (thread.status === 'error' || child.reports.at(-1)?.kind === 'error') return 'error'
      return 'idle'
    }
    const session = this.agents.get(child.taskId)
    if (!session) return 'removed'
    if (session.state === 'running') return 'running'
    if (child.closed) return 'closed'
    if (session.lastStatus === 'error' || child.reports.at(-1)?.kind === 'error') return 'error'
    return 'idle'
  }

  #modelName(child) {
    return modelName(child, this.catalog.data.models)
  }

  #label(child) {
    return `${this.#modelName(child)}・${TIER_LABEL[child.tier]}`
  }

  #emit(team) {
    if (this.teams.has(team.id)) this.emit('team', this.summary(team))
  }

  /** The team and child a task belongs to, or the team it leads. */
  #byTask(taskId) {
    for (const team of this.teams.values()) {
      if (team.leaderId === taskId) return { team, child: null }
      const child = team.children.find((entry) => entry.taskId === taskId)
      if (child) return { team, child }
    }
    return null
  }

  /** Whether the task is one of a team's children (its approvals and endings go to the leader, not the user). */
  isChild(taskId) {
    return Boolean(this.#byTask(taskId)?.child)
  }

  /** The team a task leads, if any. */
  teamLedBy(taskId) {
    return this.#byTask(taskId)?.child === null ? this.#byTask(taskId).team.id : null
  }

  /** Whether a dsh task is a child or a GPT leader: a child's subagents, and a leader's Claude (API-billed) ones, are stopped. */
  inTeam(threadId) {
    return Boolean(this.#byTask(threadId))
  }

  #childBusy(child) {
    if (!child.taskId) return true
    if (child.kind === 'thread') return this.threads.threads.get(child.taskId)?.status === 'running'
    return this.agents.running(child.taskId)
  }

  // ---------------------------------------------------------------- files

  #teamDir(team) {
    const dir = path.join(this.dir, team.id)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Writes a file a Claude Code reads (its MCP config, its instructions, a message it starts on). */
  #writeFile(team, name, text) {
    const file = path.join(this.#teamDir(team), name)
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
    return file
  }

  /**
   * The flags a team leader's Claude Code starts with (TerminalManager's
   * `launch`). The files are written each time: the server's port may have changed.
   */
  launchFor(record) {
    const team = this.teams.get(record.team?.id)
    if (!team || record.team.role !== 'leader') return null
    return leaderLaunch({
      team, config: this.config(team), models: this.catalog.data.models, dir: this.#teamDir(team),
      node: this.node, script: this.script, apiUrl: this.apiUrl(),
    })
  }

  /** The flags of every turn of a Claude child: no approvals, no tools that wait for a person (teams-launch.js). */
  #agentArgs(team, child) {
    return childTurnArgs({ child, dir: this.#teamDir(team) })
  }

  /**
   * The MCP server a GPT leader's dsh session mounts (index.js mcpServersFor):
   * the team's tools, with its instructions as the server's own. Written each
   * time a session starts: the server's port may have changed.
   */
  mcpServerFor(thread) {
    const team = thread.team?.role === 'leader' ? this.teams.get(thread.team.id) : null
    if (!team) return null
    return leaderMcpServer({
      team, config: this.config(team), models: this.catalog.data.models, dir: this.#teamDir(team),
      node: this.node, script: this.script, apiUrl: this.apiUrl(),
    })
  }

  /** The providers and tiers the leader may use, for its instructions and `status`. */
  #tierLines(config) {
    return tierLines(config, this.catalog.data.models)
  }

  // ---------------------------------------------------------------- teams

  /**
   * Starts a team in the folder. Its leader, with the team's tools, is a Claude
   * Code task or a GPT dsh task. `choices` are what the user picked when
   * starting it (a patch over the saved settings, as settings.update takes);
   * the result's `config` is what the team runs with, to remember for the next one.
   */
  async create({ workspace, size, choices = {} }) {
    const config = mergeTeamConfig(this.getSettings(), choices ?? {})
    const now = this.now()
    const gpt = config.leaderProvider === 'gpt'
    const team = {
      id: randomUUID(), secret: randomBytes(24).toString('hex'), workspace: String(workspace ?? ''), leaderId: '',
      leaderKind: gpt ? 'thread' : 'terminal', config, createdAt: now, updatedAt: now, seq: 0, children: [], queue: [], asks: [],
    }
    if (gpt) return this.#createGptLed(team, config)
    this.teams.set(team.id, team)
    let terminal
    try {
      terminal = await this.terminals.create({
        workspace: team.workspace, size, team: { id: team.id, role: 'leader' },
        model: config.leader.model, effort: config.leader.effort,
      })
    } catch (error) {
      this.teams.delete(team.id)
      throw error
    }
    team.workspace = terminal.workspace
    team.leaderId = terminal.id
    await this.#save()
    this.#emit(team)
    return { team: this.summary(team), terminal }
  }

  async #createGptLed(team, config) {
    const id = config.gptLeader.model ?? config.gpt.mid.model ?? config.gpt.low.model
    if (!id) throw new Error('GPT のリーダーのモデルが決まっていません。チームを始める画面で選んでください')
    const model = this.catalog.data.models.find((entry) => entry.provider === 'openai-codex' && entry.id === id)?.value
      ?? JSON.stringify(['openai-codex', id])
    this.teams.set(team.id, team)
    let thread
    try {
      // Marked as the leader from the start: its session mounts the team's tools (mcpServerFor).
      thread = await this.threads.create({
        workspace: team.workspace, model, effort: config.gptLeader.effort ?? '',
        permissionMode: config.leaderBypass ? 'danger-full-access' : 'workspace-write', team: { id: team.id, role: 'leader' },
      })
    } catch (error) {
      this.teams.delete(team.id)
      throw error
    }
    team.workspace = thread.workspace
    team.leaderId = thread.id
    await this.threads.update(thread.id, { title: 'エージェントチーム' }).catch(() => {})
    await this.#save()
    this.#emit(team)
    return { team: this.summary(team), thread: { ...thread, title: 'エージェントチーム' } }
  }

  /** Deletes a team with its leader and every child task. */
  async removeTeam(teamId) {
    const team = this.teams.get(teamId)
    if (!team) return { removed: false }
    this.teams.delete(teamId)
    for (const approval of [...this.approvals.values()]) {
      if (approval.teamId === teamId) this.#dropApproval(approval)
    }
    clearTimeout(this.retries.get(teamId))
    this.retries.delete(teamId)
    clearTimeout(this.delivering.get(teamId)?.timer)
    this.delivering.delete(teamId)
    for (const child of team.children) {
      if (!child.taskId) continue
      try {
        if (child.kind === 'thread') await this.threads.remove(child.taskId)
        else await this.agents.remove(child.taskId)
      } catch (error) {
        this.log(`team ${teamId}: removing child ${child.name}:`, error.message)
      }
    }
    if (team.leaderKind === 'thread') {
      if (this.threads.threads.has(team.leaderId)) await this.threads.remove(team.leaderId)
    } else if (this.terminals.records.has(team.leaderId)) await this.terminals.remove(team.leaderId)
    fs.rmSync(path.join(this.dir, teamId), { recursive: true, force: true })
    await this.#save()
    this.emit('removed', { teamId })
    return { removed: true }
  }

  // ---------------------------------------------------------------- the leader's tools

  /** A tool call from team-mcp.js, authenticated by the team's secret; returns the text the leader reads. */
  async call(teamId, secret, tool, args) {
    const team = this.teams.get(teamId)
    if (!team || !sameToken(secret, team.secret)) {
      const error = new Error('forbidden')
      error.status = 403
      throw error
    }
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    switch (tool) {
      case 'spawn': return this.#spawn(team, input)
      case 'send': return this.#send(team, input)
      case 'status': return this.#status(team)
      case 'read_report': return this.#readReport(team, input)
      case 'approve': return this.#approve(team, input)
      case 'ask_user': return this.#askUser(team, input)
      case 'close': return this.#close(team, input)
      default: throw new Error(`unknown tool: ${tool}`)
    }
  }

  #child(team, ref) {
    const key = String(ref ?? '').trim().toLowerCase()
    if (!key) throw new Error('child（子の名前）を指定してください')
    const child = team.children.find((entry) => entry.name.toLowerCase() === key || entry.id === key)
    if (!child) {
      const names = team.children.map((entry) => `「${entry.name}」`).join('、')
      throw new Error(`子「${ref}」はいません。${names ? `いる子: ${names}` : 'まだ子はいません。'}`)
    }
    return child
  }

  /** A child starts, or starts again, only where a place is free: closed children do not count. */
  #checkRoom(team) {
    const { maxChildren } = this.config(team)
    const open = team.children.filter((entry) => !entry.closed).length
    if (open >= maxChildren) {
      throw new Error(`開いている子が上限（${maxChildren} 人）です。合格した子を close するか、空きを待ってください。`)
    }
  }

  #childName(team, wanted) {
    const taken = (name) => team.children.some((entry) => entry.name.toLowerCase() === name.toLowerCase())
    if (wanted !== undefined && wanted !== null && String(wanted).trim()) {
      const name = oneLine(String(wanted)).slice(0, 24)
      if (taken(name)) throw new Error(`「${name}」という名前の子はもういます。別の名前にするか、その子に send してください。`)
      return name
    }
    let name
    do {
      team.seq = (team.seq ?? 0) + 1
      name = `子${team.seq}`
    } while (taken(name))
    return name
  }

  async #spawn(team, args) {
    const config = this.config(team)
    const title = oneLine(String(args.title ?? '')).slice(0, 80)
    const task = String(args.task ?? '').trim()
    if (!title) throw new Error('title（業務のタイトル）を指定してください')
    if (!task) throw new Error('task（依頼の本文）を指定してください')
    const tier = args.tier
    if (!TEAM_TIERS.includes(tier)) throw new Error('tier は "low" か "mid" で指定してください')
    const enabled = TEAM_PROVIDERS.filter((provider) => config[provider].enabled)
    let provider = args.provider && args.provider !== 'auto' ? args.provider : null
    if (provider && !TEAM_PROVIDERS.includes(provider)) throw new Error(`provider は ${providerList(TEAM_PROVIDERS)} のどれかで指定してください`)
    if (provider && !config[provider].enabled) {
      throw new Error(`${PROVIDER_NAMES[provider]} の子はユーザーが設定でオフにしています。${providerList(enabled)} を使ってください。`)
    }
    if (!provider) {
      if (enabled.length !== 1) throw new Error(`provider を ${providerList(enabled)} のどれかで指定してください`)
      provider = enabled[0]
    }
    const { enabled: tierOn, model, effort } = config[provider][tier]
    if (!tierOn) {
      throw new Error(`${PROVIDER_NAMES[provider]}の${TIER_LABEL[tier]}枠はユーザーがオフにしています。使える枠は status で確かめてください。`)
    }
    if (!model) {
      throw new Error(`${PROVIDER_NAMES[provider]}の${TIER_LABEL[tier]}枠のモデルが設定されていません。別の枠を使うか、ask_user でユーザーにチームパネルの「このチームの設定」で選んでもらってください。`)
    }
    this.#checkRoom(team)
    const now = this.now()
    const child = {
      id: randomUUID(), name: this.#childName(team, args.name), title, provider, tier, model, effort: effort ?? null,
      kind: provider === 'claude' ? 'agent' : 'thread', taskId: null, createdAt: now, updatedAt: now,
      closed: false, awaiting: true, pending: [], reports: [],
    }
    team.children.push(child)
    // The task's name in the lists; a leader that named the child after its job gets it once.
    const taskTitle = child.name === title ? title : `${child.name}: ${title}`
    try {
      if (child.kind === 'thread') {
        const catalogProvider = CATALOG_PROVIDER[provider]
        const value = this.catalog.data.models.find((entry) => entry.provider === catalogProvider && entry.id === model)?.value
          ?? JSON.stringify([catalogProvider, model])
        const thread = await this.threads.create({
          workspace: team.workspace, model: value, effort: child.effort ?? '', permissionMode: 'danger-full-access',
          team: { id: team.id, childId: child.id },
        })
        child.taskId = thread.id
        if (!this.teams.has(team.id)) throw new Error('team was removed')
        await this.threads.send(thread.id, { text: `${PREFIX}\n${childPrompt(child.name)}\n\n# Task: ${title}\n\n${task}` })
        await this.threads.update(thread.id, { title: taskTitle })
      } else {
        const session = await this.agents.create({
          workspace: team.workspace, model, effort: child.effort, args: this.#agentArgs(team, child),
        })
        child.taskId = session.id
        if (!this.teams.has(team.id)) throw new Error('team was removed')
        this.agents.run(session.id, `# Task from the team leader: ${title}\n\n${task}`)
      }
    } catch (error) {
      team.children = team.children.filter((entry) => entry !== child)
      if (child.taskId) {
        const removal = child.kind === 'thread' ? this.threads.remove(child.taskId) : this.agents.remove(child.taskId)
        await Promise.resolve(removal).catch(() => {})
      }
      this.#emit(team)
      throw error
    }
    team.updatedAt = now
    await this.#save()
    this.#emit(team)
    return `子「${child.name}」を起動しました（${this.#label(child)}）。終わると報告がこの会話に届きます。ほかに任せる作業がなければ、ターンを終えて待ってください。`
  }

  async #send(team, args) {
    const child = this.#child(team, args.child)
    const text = String(args.message ?? '').trim()
    if (!text) throw new Error('message（子に送る内容）を指定してください')
    // A closed child takes a place again.
    const wasClosed = child.closed
    if (child.closed) this.#checkRoom(team)
    const body = `[リーダーから]\n${text}`
    child.closed = false
    child.awaiting = true
    child.updatedAt = this.now()
    let how
    try {
      how = child.kind === 'thread' ? await this.#toThread(child, body) : this.#toAgent(child, body)
    } catch (error) {
      child.closed = wasClosed
      child.awaiting = false
      throw error
    }
    await this.#save()
    this.#emit(team)
    return `子「${child.name}」に${how}。報告が届くまで、ターンを終えて待ってください。`
  }

  async #toThread(child, body) {
    const thread = this.threads.threads.get(child.taskId)
    if (!thread) throw new Error(`子「${child.name}」のタスクは削除されています`)
    if (thread.status === 'running') {
      const result = await this.threads.steer(child.taskId, { text: body })
      if (result?.steered) return '作業中のところへ割り込みで渡しました'
      child.pending.push(body)
      return 'いまの作業が終わりしだい渡します'
    }
    await this.threads.send(child.taskId, { text: body })
    return '送りました'
  }

  /** A Claude child takes a message as its next turn, which resumes its conversation. */
  #toAgent(child, body) {
    if (!this.agents.get(child.taskId)) throw new Error(`子「${child.name}」のタスクは削除されています`)
    if (this.agents.running(child.taskId)) {
      child.pending.push(body)
      return 'いまの作業が終わりしだい渡します'
    }
    this.agents.run(child.taskId, body)
    return '送りました'
  }

  /** Messages for a child that was busy when they came: they go together once it is free. */
  async #flushChild(team, child) {
    if (!child.pending.length || !this.teams.has(team.id)) return
    const text = child.pending.join('\n\n')
    if (child.kind === 'thread') {
      const thread = this.threads.threads.get(child.taskId)
      if (!thread || thread.status === 'running') return
      child.pending = []
      child.awaiting = true
      try {
        await this.threads.send(child.taskId, { text })
      } catch (error) {
        this.#report(team, child, 'error', `リーダーからの指示を渡せませんでした: ${error.message}`)
      }
    } else {
      if (!this.agents.get(child.taskId) || this.agents.running(child.taskId)) return
      child.pending = []
      child.awaiting = true
      try {
        this.agents.run(child.taskId, text)
      } catch (error) {
        child.awaiting = false
        this.#report(team, child, 'error', `リーダーからの指示を渡せませんでした: ${error.message}`)
      }
    }
    void this.#save()
    this.#emit(team)
  }

  #status(team) {
    const config = this.config(team)
    const open = team.children.filter((entry) => !entry.closed)
    const lines = [
      `開いている子: ${open.length} / ${config.maxChildren} 人。リーダーへの報告待ち: ${team.queue.length} 件。`,
      '使える枠:',
      ...this.#tierLines(config),
    ]
    if (!team.children.length) lines.push('子はまだいません。')
    for (const child of team.children) {
      const state = STATE_LABEL[this.#childState(child)] ?? this.#childState(child)
      lines.push(`- ${child.name} [${state}] ${this.#label(child)} — ${child.title}（報告 ${child.reports.length} 件${child.pending.length ? `・未送信の指示 ${child.pending.length} 件` : ''}）`)
    }
    return lines.join('\n')
  }

  /**
   * A child's latest report in full, with the earlier ones of it that were
   * still waiting for the leader: those read here are not handed to it again.
   */
  #readReport(team, args) {
    const child = this.#child(team, args.child)
    const report = child.reports.at(-1)
    if (!report) return `子「${child.name}」からの報告はまだありません。`
    const waiting = team.queue.filter((item) => item.childId === child.id && item.kind !== 'approval')
    // Each in full while it is kept (the oldest may have only its shortened text left).
    const shown = []
    for (const item of waiting) shown.push(child.reports.find((entry) => entry.at === item.at && !shown.includes(entry)) ?? item)
    if (!shown.includes(report)) shown.push(report)
    shown.sort((a, b) => a.at - b.at)
    if (waiting.length) {
      team.queue = team.queue.filter((item) => !waiting.includes(item))
      void this.#save()
      this.#emit(team)
    }
    const when = (entry) => new Date(entry.at).toLocaleString('ja-JP')
    if (shown.length === 1) return `子「${child.name}」の最新の報告（${when(report)}・全 ${child.reports.length} 件）\n---\n${report.text}`
    return [
      `子「${child.name}」の、まだ届いていなかった報告 ${shown.length} 件（古い順・全 ${child.reports.length} 件）。ここで読んだものは、あとから届きません。`,
      ...shown.map((entry, index) => `--- ${index + 1}/${shown.length}（${when(entry)}）\n${entry.text}`),
    ].join('\n')
  }

  async #approve(team, args) {
    const child = this.#child(team, args.child)
    if (typeof args.allow !== 'boolean') throw new Error('allow（許可するなら true、拒否するなら false）を指定してください')
    // The reason of a denial goes to the child as its next message: an answer to an approval has no room for it.
    const reason = String(args.message ?? '').trim()
    const approval = [...this.approvals.values()].filter((entry) => entry.childId === child.id).sort((a, b) => a.at - b.at)[0]
    if (!approval) {
      // A Claude child is never asked (what it could not do is in its report): its denial's reason still goes to it.
      if (args.allow || !reason || child.closed || child.kind === 'thread') return `子「${child.name}」が待っている承認はありません（すでに解決済みです）。`
      await this.#send(team, { child: child.name, message: `承認が要る操作は許可しません。理由: ${reason}` })
      return `子「${child.name}」が待っている承認はありません。拒否の理由は子に送りました。`
    }
    this.#settleApproval(team, approval, args.allow)
    if (args.allow || !reason) return `子「${child.name}」の「${approval.tool}」を${args.allow ? '許可' : '拒否'}しました。`
    await this.#send(team, { child: child.name, message: `「${approval.tool}」の承認を拒否しました。理由: ${reason}` })
    return `子「${child.name}」の「${approval.tool}」を拒否しました。理由は子に送りました。`
  }

  #askUser(team, args) {
    const text = String(args.message ?? '').trim()
    if (!text) throw new Error('message（ユーザーに確認したいこと）を指定してください')
    const child = args.child ? this.#child(team, args.child) : null
    const ask = { id: randomUUID(), at: this.now(), text: clip(text, 2000), childId: child?.id ?? null, done: false }
    team.asks = [...team.asks, ask].slice(-ASKS_KEPT)
    void this.#save()
    this.#emit(team)
    this.emit('ask', { teamId: team.id, leaderId: team.leaderId, leaderKind: team.leaderKind, text: ask.text })
    return 'ユーザーに知らせました。返事はこの会話に届きます。ターンを終えて待ってください。'
  }

  async #close(team, args) {
    const child = this.#child(team, args.child)
    child.closed = true
    child.awaiting = false
    child.pending = []
    child.updatedAt = this.now()
    for (const approval of [...this.approvals.values()]) {
      if (approval.childId === child.id) this.#settleApproval(team, approval, false)
    }
    if (child.kind === 'thread') {
      if (this.threads.threads.get(child.taskId)?.status === 'running') await this.threads.cancel(child.taskId)
    } else {
      this.agents.stop(child.taskId)
    }
    await this.#save()
    this.#emit(team)
    return `子「${child.name}」を終了しました。同じ範囲の作業は、あとから send で頼めます（会話を引き継いで再開します）。`
  }

  // ---------------------------------------------------------------- the user's actions

  /** The user decided an approval in the team's panel. */
  approveById(teamId, approvalId, allow) {
    const team = this.teams.get(teamId)
    const approval = this.approvals.get(approvalId)
    if (!team || !approval || approval.teamId !== teamId) throw new Error('この承認はすでに終わっています')
    this.#settleApproval(team, approval, Boolean(allow))
    return { team: this.summary(team) }
  }

  dismissAsk(teamId, askId) {
    const team = this.teams.get(teamId)
    if (!team) throw new Error('チームが見つかりません')
    for (const ask of team.asks) if (ask.id === askId || askId === undefined) ask.done = true
    void this.#save()
    this.#emit(team)
    return { team: this.summary(team) }
  }

  /**
   * The user wrote to a Claude child in its own view: its reply also goes to
   * the leader (as a report it did not ask for) while the child is open.
   */
  messageChild(teamId, childId, text) {
    const team = this.teams.get(teamId)
    const child = team?.children.find((entry) => entry.id === childId)
    if (!child || child.kind !== 'agent') throw new Error('この子は見つかりません')
    const body = String(text ?? '').trim()
    if (!body) throw new Error('送る内容を書いてください')
    this.agents.run(child.taskId, body)
    return { team: this.summary(team) }
  }

  /** The user stopped a Claude child's turn in its view (the leader hears it was stopped). */
  stopChild(teamId, childId) {
    const team = this.teams.get(teamId)
    const child = team?.children.find((entry) => entry.id === childId)
    if (!child || child.kind !== 'agent') throw new Error('この子は見つかりません')
    this.agents.stop(child.taskId)
    return { team: this.summary(team) }
  }

  /**
   * The user stopped every working child at once. Each one's turn ends as with
   * `stopChild` (a GPT child's too) and its conversation stays; none is closed.
   */
  async stopAll(teamId) {
    const team = this.teams.get(teamId)
    if (!team) throw new Error('チームが見つかりません')
    let stopped = 0
    for (const child of team.children) {
      if (!child.taskId || !this.#childBusy(child)) continue
      this.userStopped.add(child.id)
      try {
        if (child.kind === 'thread') await this.threads.cancel(child.taskId)
        else this.agents.stop(child.taskId)
      } catch (error) {
        this.userStopped.delete(child.id)
        throw error
      }
      stopped += 1
    }
    return { team: this.summary(team), stopped }
  }

  /**
   * The user changed a running team's settings in its panel: the children's
   * providers and tiers and how many may be open. Who leads stays (the leader
   * is its own task). The leader hears what it may use now.
   */
  updateConfig(teamId, patch) {
    const team = this.teams.get(teamId)
    if (!team) throw new Error('チームが見つかりません')
    const allowed = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => [...TEAM_PROVIDERS, 'maxChildren'].includes(key)))
    const before = this.#tierLines(this.config(team)).join('\n') + this.config(team).maxChildren
    team.config = mergeTeamConfig(this.config(team), allowed)
    team.updatedAt = this.now()
    const config = this.config(team)
    if (this.#tierLines(config).join('\n') + config.maxChildren !== before) {
      team.queue.push({
        id: randomUUID(), childId: null, kind: 'notice', at: team.updatedAt,
        text: [`ユーザーがこのチームの設定を変えました。いまから使える枠（同時に開ける子は ${config.maxChildren} 人まで）:`, ...this.#tierLines(config),
          'すでに動いている子はそのままのモデルで続けます。返事は要りません。次に spawn するときから、この枠で選んでください。'].join('\n'),
      })
    }
    void this.#save()
    this.#emit(team)
    this.#pump(team)
    return { team: this.summary(team) }
  }

  /** Tries again to hand the leader a report it did not take. */
  retryDelivery(teamId) {
    const team = this.teams.get(teamId)
    if (!team) throw new Error('チームが見つかりません')
    team.deliveryFailed = false
    this.#pump(team)
    this.#emit(team)
    return { team: this.summary(team) }
  }

  // ---------------------------------------------------------------- reports to the leader

  #report(team, child, kind, text, extra = {}) {
    const body = String(text ?? '').trim() || '（返答の本文はありませんでした）'
    const at = this.now()
    if (kind !== 'approval') child.reports = [...child.reports, { at, kind, text: clip(body, REPORT_KEEP) }].slice(-REPORTS_KEPT)
    child.updatedAt = at
    const shown = body.length > REPORT_PREVIEW ? `${body.slice(0, REPORT_PREVIEW)}…\n（続きは read_report で読めます）` : body
    team.queue.push({ id: randomUUID(), childId: child.id, kind, text: shown, at, ...extra })
    team.updatedAt = at
    void this.#save()
    this.#emit(team)
    this.#pump(team)
  }

  #leaderMessage(team, item) {
    return reportMessage(team, item, (child) => this.#label(child))
  }

  #later(key, fn, ms) {
    clearTimeout(this.retries.get(key))
    this.retries.set(key, setTimeout(() => {
      this.retries.delete(key)
      fn()
    }, Math.max(50, ms)))
  }

  /** Types the next report into the leader when it can take one: running, idle, not being typed into. */
  #pump(team) {
    if (!this.teams.has(team.id) || this.delivering.has(team.id) || team.deliveryFailed) return
    // An approval decided (in the panel) while it waited needs no message any more.
    team.queue = team.queue.filter((item) => item.kind !== 'approval' || this.approvals.has(item.approvalId))
    if (!team.queue.length) return
    if (team.leaderKind === 'thread') return this.#pumpThread(team)
    const status = this.terminals.status(team.leaderId)
    if (!status) return
    if (status.state === 'stopped') {
      // Not started since the app started: it resumes its conversation on the report.
      const item = team.queue.shift()
      const file = this.#writeFile(team, `report-${item.id}.md`, `${this.#leaderMessage(team, item)}\n`)
      this.#deliver(team, item, () => this.terminals.restart(team.leaderId, null, undefined, {
        prompt: `${PREFIX} #${markOf(item)} A message from your team arrived while this session was stopped. Read this file and act on it: ${file}`,
      }))
      return
    }
    // Ended by the user: the report waits until they resume it (the panel says so).
    if (status.state === 'exited') return this.#emit(team)
    // Its turn ending brings the next report here.
    if (status.activity !== 'idle') return this.#settleLater(team)
    if (!status.ready) return this.#later(team.id, () => this.#pump(team), RETRY_MS)
    const quiet = this.now() - status.inputAt
    if (quiet < TYPING_QUIET_MS) return this.#later(team.id, () => this.#pump(team), TYPING_QUIET_MS - quiet)
    const item = team.queue.shift()
    this.#deliver(team, item, () => this.terminals.sendMessage(team.leaderId, this.#leaderMessage(team, item)))
  }

  /**
   * A GPT leader takes the next report as a message once its turn has ended.
   * dsh says when a turn ends, and a message is handed over whole, so nothing
   * needs checking afterwards.
   */
  #pumpThread(team) {
    const thread = this.threads.threads.get(team.leaderId)
    if (!thread || thread.status === 'running') return
    const item = team.queue.shift()
    const entry = { item, timer: null }
    this.delivering.set(team.id, entry)
    const done = () => {
      if (this.delivering.get(team.id) === entry) this.delivering.delete(team.id)
      void this.#save()
      this.#emit(team)
    }
    this.threads.send(team.leaderId, { text: this.#leaderMessage(team, item) }).then(() => {
      team.deliveryFailed = false
      done()
    }, (error) => {
      team.queue.unshift(item)
      team.deliveryFailed = true
      this.log(`team ${team.id}: could not hand the leader a report:`, error.message)
      done()
    })
    this.#emit(team)
  }

  /** The user wrote to a leader (a GPT leader's thread.send, or a Claude leader's own prompt, #onLeaderHook): the questions it asked are being answered. */
  userWrote(threadId) {
    const found = this.#byTask(threadId)
    if (!found || found.child || !found.team.asks.some((ask) => !ask.done)) return
    for (const ask of found.team.asks) ask.done = true
    void this.#save()
    this.#emit(found.team)
  }

  /** Checks the leader's conversation file once it has looked busy for a while (LEADER_SETTLE_MS). */
  #settleLater(team) {
    const key = `settle:${team.id}`
    if (this.retries.has(key)) return
    this.retries.set(key, setTimeout(async () => {
      this.retries.delete(key)
      if (!this.teams.has(team.id) || !team.queue.length) return
      try {
        // Marks the leader idle when its last turn has ended; that change pumps the queue.
        if (!(await this.terminals.settle(team.leaderId))) this.#settleLater(team)
      } catch (error) {
        this.log(`team ${team.id}: checking the leader:`, error.message)
      }
    }, LEADER_SETTLE_MS))
  }

  /**
   * Hands one report to the leader with `action`, then waits for the leader to
   * start on it; else presses Enter once more, waits longer (Claude Code can
   * take a minute or more to take in a long paste, and an Enter pressed
   * meanwhile waits for it), then gives the report back.
   * The delivery is marked first: the leader starting is not the user writing.
   */
  #deliver(team, item, action) {
    const entry = { item, entered: false, timer: null, pasted: this.now() }
    this.delivering.set(team.id, entry)
    try {
      action()
    } catch (error) {
      this.delivering.delete(team.id)
      team.queue.unshift(item)
      this.log(`team ${team.id}: could not hand the leader a report:`, error.message)
      return
    }
    if (this.delivering.get(team.id) !== entry) return void this.#save()
    const check = () => {
      if (this.delivering.get(team.id) !== entry) return
      const status = this.terminals.status(team.leaderId)
      if (status?.state === 'running' && status.activity !== 'idle') return this.#delivered(team)
      if (!entry.entered && status?.state === 'running') {
        entry.entered = true
        // The user typed since the paste: their words are in the box with the report, so Enter is left to them.
        const typed = status.inputAt > entry.pasted
        if (!typed) this.terminals.pressEnter(team.leaderId)
        entry.timer = setTimeout(check, DELIVERY_GIVE_UP_MS)
        return
      }
      this.delivering.delete(team.id)
      team.queue.unshift(item)
      team.deliveryFailed = true
      this.log(`team ${team.id}: the leader did not take a report`)
      this.#emit(team)
    }
    entry.timer = setTimeout(check, DELIVERY_CHECK_MS)
    void this.#save()
    this.#emit(team)
  }

  #delivered(team) {
    const entry = this.delivering.get(team.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.delivering.delete(team.id)
    team.deliveryFailed = false
    // Saved now: a report the leader took must not come back marked as handed over after a restart.
    void this.#save()
    this.#emit(team)
  }

  /**
   * A Claude leader took a prompt (claude-hook.js says which team messages it
   * carries). A message taken after it was given up is not sent again, and
   * whatever was left in the input box has gone with this prompt, so
   * reports that waited for a retry go on once this turn ends.
   */
  #onLeaderHook({ terminalId, input }) {
    if (input?.hook_event_name !== 'UserPromptSubmit' || !Array.isArray(input.team_marks)) return
    const found = this.#byTask(terminalId)
    if (!found || found.child) return
    const { team } = found
    const marks = input.team_marks.map(String)
    // A prompt without team marks is the user's own: its answer to the questions the leader asked.
    if (!marks.length) this.userWrote(terminalId)
    const entry = this.delivering.get(team.id)
    if (entry && marks.includes(markOf(entry.item))) this.#delivered(team)
    const before = team.queue.length
    team.queue = team.queue.filter((item) => !marks.includes(markOf(item)))
    if (team.queue.length === before && !team.deliveryFailed) return
    team.deliveryFailed = false
    void this.#save()
    this.#emit(team)
  }

  // ---------------------------------------------------------------- approvals

  #settleApproval(team, approval, allow) {
    const pending = this.threads.pendingPermissions(approval.taskId).find((entry) => entry.requestId === approval.requestId)
    const option = pending?.options.find((entry) => String(entry.kind).startsWith(allow ? 'allow_once' : 'reject_once'))
      ?? pending?.options.find((entry) => String(entry.kind).startsWith(allow ? 'allow' : 'reject'))
    if (pending) {
      try {
        this.threads.respondPermission(approval.requestId, option?.optionId ?? null)
      } catch {}
    }
    this.#dropApproval(approval)
    team.queue = team.queue.filter((item) => item.approvalId !== approval.id)
    void this.#save()
    this.#emit(team)
  }

  #dropApproval(approval) {
    this.approvals.delete(approval.id)
    clearTimeout(approval.timer)
  }

  // ---------------------------------------------------------------- task events

  #onThread(thread) {
    const found = this.#byTask(thread.id)
    if (!found) return
    if (!found.child) {
      // A GPT leader: its state shows in the panel, and an idle one takes the next report.
      if (thread.status !== 'running') this.#pump(found.team)
      return this.#emit(found.team)
    }
    if (!thread.pendingApproval) {
      // Answered in the task itself, or the turn ended.
      for (const approval of [...this.approvals.values()]) {
        if (approval.taskId === thread.id) this.#dropApproval(approval)
      }
    }
    this.#emit(found.team)
  }

  #onThreadApproval({ threadId }) {
    const found = this.#byTask(threadId)
    if (!found?.child) return
    const { team, child } = found
    for (const pending of this.threads.pendingPermissions(threadId)) {
      if ([...this.approvals.values()].some((entry) => entry.requestId === pending.requestId)) continue
      const approval = {
        id: randomUUID(), teamId: team.id, childId: child.id, taskId: threadId, requestId: pending.requestId,
        tool: describeTool(pending.name, pending.input), at: this.now(), timer: null,
      }
      // dsh waits for an answer for good: when the leader does not give one in time, the user hears of it.
      approval.timer = setTimeout(() => {
        if (this.approvals.get(approval.id) === approval) {
          this.emit('stuck', { teamId: team.id, leaderId: team.leaderId, leaderKind: team.leaderKind, title: `子「${child.name}」: ${approval.tool}` })
        }
      }, APPROVAL_WAIT_MS)
      approval.timer.unref?.()
      this.approvals.set(approval.id, approval)
      this.#report(team, child, 'approval', approval.tool, { approvalId: approval.id })
    }
  }

  /**
   * A GPT or DeepSeek child started a subagent (its dsh has none, so this is
   * the backstop), or a GPT leader started one on Claude, which bills the
   * user's Anthropic API key: the turn stops at once and the leader hears why.
   */
  async stopApiUse(threadId) {
    const found = this.#byTask(threadId)
    if (!found || (found.child ? found.child.kind !== 'thread' : found.team.leaderKind !== 'thread')) return
    const key = found.child?.id ?? `leader:${found.team.id}`
    if (this.apiStopped.has(key)) return
    this.apiStopped.add(key)
    this.log(`team ${found.team.id}: stopped ${found.child ? `child ${found.child.name} (subagent)` : 'the leader (Claude API subagent)'}`)
    await this.threads.cancel(threadId)
  }

  /**
   * Whether a child's finished turn goes to the leader: the work the leader
   * sent, and also a turn the child started on its own while open (Claude Code
   * wakes up when a background command ends) or one the user asked for in the
   * child directly. A closed child's turns stay its own.
   */
  #reportsTurn(child) {
    return child.awaiting || !child.closed
  }

  #onThreadFinished({ threadId, status }) {
    const found = this.#byTask(threadId)
    if (!found) return
    if (!found.child) return this.#onLeaderFinished(found.team)
    const { team, child } = found
    const apiStopped = this.apiStopped.delete(child.id)
    const byUser = this.userStopped.delete(child.id)
    if (this.#reportsTurn(child)) {
      const extra = child.awaiting ? {} : { unasked: true }
      child.awaiting = false
      const turn = this.threads.turns.get(threadId)?.at(-1)
      const answer = turn?.items?.filter((item) => item.type === 'agent').at(-1)?.text ?? ''
      if (apiStopped) {
        this.#report(team, child, 'error', [
          'Agent Desk がこの子の作業を止めました: チームの子はサブエージェントを使えません。'
            + 'send で自分で作業するよう指示するか、分けたい作業は別の子として spawn してください。',
          answer,
        ].filter(Boolean).join('\n\n'), extra)
      } else if (status === 'error') this.#report(team, child, 'error', [turn?.error?.message, answer].filter(Boolean).join('\n\n'), extra)
      else if (status === 'cancelled') this.#report(team, child, 'cancelled', answer, byUser ? { ...extra, byUser } : extra)
      else this.#report(team, child, 'report', answer, extra)
    }
    void this.#flushChild(team, child)
    this.#emit(team)
  }

  /** A GPT leader's turn ended: why, if Agent Desk stopped it; then the next report. */
  #onLeaderFinished(team) {
    if (this.apiStopped.delete(`leader:${team.id}`)) {
      team.queue.unshift({
        id: randomUUID(), childId: null, kind: 'notice', at: this.now(),
        text: 'Agent Desk があなたの作業を止めました: Claude のサブエージェント（subagent_claude）は Anthropic API の従量課金になるため、チームでは使えません。'
          + 'チームの作業は spawn で子に任せてください。',
      })
    }
    this.#pump(team)
    this.#emit(team)
  }

  #onTerminal(summary) {
    const found = this.#byTask(summary.id)
    if (!found) return
    const { team, child } = found
    if (child) {
      if (summary.activity === 'idle') void this.#flushChild(team, child)
      return this.#emit(team)
    }
    if (summary.state === 'running' && summary.activity !== 'idle') {
      if (this.delivering.has(team.id)) this.#delivered(team)
    } else {
      this.#pump(team)
    }
    this.#emit(team)
  }

  #onAgent(session) {
    const found = this.#byTask(session.id)
    if (found?.child) this.#emit(found.team)
  }

  #onAgentFinished({ id, status, text, error, denials }) {
    const found = this.#byTask(id)
    if (!found?.child) return
    const { team, child } = found
    const byUser = this.userStopped.delete(child.id)
    if (this.#reportsTurn(child)) {
      const extra = child.awaiting ? {} : { unasked: true }
      child.awaiting = false
      // What would have asked for an approval was denied (nobody is there to answer): the leader decides what to do.
      const denied = (denials ?? []).map((entry) => `- ${describeTool(entry?.tool_name, entry?.tool_input)}`)
      const note = denied.length ? `（承認が必要なため実行されなかった操作）\n${denied.join('\n')}` : ''
      if (status === 'error') this.#report(team, child, 'error', [error, text, note].filter(Boolean).join('\n\n'), extra)
      else if (status === 'cancelled') this.#report(team, child, 'cancelled', text, byUser ? { ...extra, byUser } : extra)
      else this.#report(team, child, 'report', [text, note].filter(Boolean).join('\n\n'), extra)
    }
    void this.#flushChild(team, child)
    this.#emit(team)
  }

  #onTaskRemoved(taskId) {
    const found = this.#byTask(taskId)
    if (!found) return
    const { team, child } = found
    if (!child) {
      void this.removeTeam(team.id)
      return
    }
    for (const approval of [...this.approvals.values()]) {
      if (approval.childId === child.id) this.#dropApproval(approval)
    }
    team.children = team.children.filter((entry) => entry !== child)
    team.queue = team.queue.filter((item) => item.childId !== child.id)
    void this.#save()
    this.#emit(team)
  }
}
