// Subagents that run as another kind of task (settings: subagentRoutes).
//
// A DSH, Claude Code or Codex task whose route points elsewhere gets one MCP
// tool, `subagent` (subagent-bridge-mcp.js), that posts its prompt here. The
// child runs as the route's kind with the route's model and reasoning level,
// never wider than the task's own permission, and has no subagent tools of its
// own. The answer comes back with the model that actually ran it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { abClaudeArgs } from './ab-runner.js'
import { SUBAGENT_TOOLS } from './dsh-config.js'
import { readJson, writeJson } from './json-file.js'
import { isLeaderUsageLimit } from './leader-usage-limit.js'
import { TIMEOUT_ENV } from './mcp-timeout-patch.js'
import { runDshChild } from './subagent-dsh.js'
import { CLAUDE_PREFIX, CODEX_PREFIX, dshModelParts, routePlan, savedRoutes } from './subagent-routes.js'

const mcpScript = fileURLToPath(new URL('./subagent-bridge-mcp.js', import.meta.url))
export const BRIDGE_MCP_SERVER = 'agent-desk-subagent'
/** Codex ends an MCP call after a minute unless told otherwise; a subagent can work for hours. */
export const SUBAGENT_TOOL_TIMEOUT_SEC = 6 * 60 * 60

const CHILD_NOTE = 'You are a subagent another agent started. Do the task you are given in the working folder and reply with your final report. '
  + 'You cannot start subagents or ask the user questions: finish with what you could do and say what blocked you.'

/** Resolves with the `finished` event of one session. */
function finishedOf(runner, id) {
  return new Promise((resolve) => {
    const on = (event) => {
      if (event.id !== id) return
      runner.off('finished', on)
      resolve(event)
    }
    runner.on('finished', on)
  })
}

const outcome = (event) => {
  if (event.status === 'done') return event.text || '(the subagent returned no text)'
  throw new Error(event.error || `The subagent did not finish (${event.status}).`)
}

export class SubagentBridge {
  /**
   * @param {object} options
   * @param {string} options.file - where the secret is kept
   * @param {object} options.paths - appPaths()
   * @param {() => object} options.settings - the live settings
   * @param {() => string} options.url - Agent Desk's endpoint for the MCP
   * @param {{ dsh: Function, cl: Function, gp: Function }} options.parents - `(id) => { workspace, mode, model?, effort? } | null`
   *   for each kind of task: where it works, its permission mode, and (Codex) its own model
   * @param {import('./claude-runner.js').ClaudeRunner} options.claude - runs Claude Code children
   * @param {import('./codex-runner.js').CodexRunner} options.codex - runs Codex children
   * @param {() => string} [options.instructions] - the user's custom instructions
   * @param {(kind: string, child: object) => Promise<string>} options.dshPatch - writes a DSH child's model layer, returns its path
   */
  constructor({ file, paths, settings, url, parents, claude, codex, instructions = () => '', dshPatch, runDsh = runDshChild }) {
    this.file = file
    this.paths = paths
    this.settings = settings
    this.url = url
    this.parents = parents
    this.claude = claude
    this.codex = codex
    this.instructions = instructions
    this.dshPatch = dshPatch
    this.runDsh = runDsh
    this.secret = null
  }

  /** Reads (or makes) the secret, and drops children an exit left behind. */
  async load() {
    const saved = await readJson(this.file, null, { recoverCorrupt: false }).catch(() => null)
    if (typeof saved?.secret === 'string' && saved.secret.length >= 32) this.secret = saved.secret
    else {
      this.secret = randomBytes(32).toString('hex')
      await writeJson(this.file, { secret: this.secret })
    }
    await Promise.allSettled([
      ...this.codex.list({ includeOwned: true }).filter((session) => session.subagent).map((session) => this.codex.remove(session.id)),
      ...[...this.claude.records.keys()].map((id) => this.claude.remove(id)),
    ])
    return this
  }

  #token(kind, id) {
    return createHmac('sha256', this.secret).update(`${kind}:${id}`).digest('hex')
  }

  /** `kind:id` of the task a call comes from, when its token is the one issued for it. */
  authorize(parent, token) {
    const [kind, ...rest] = String(parent ?? '').split(':')
    const id = rest.join(':')
    if (!['dsh', 'cl', 'gp'].includes(kind) || !id || typeof token !== 'string') return null
    const wanted = Buffer.from(this.#token(kind, id))
    const given = Buffer.from(token)
    return given.length === wanted.length && timingSafeEqual(given, wanted) ? { kind, id } : null
  }

  #plan(kind) {
    const settings = this.settings()
    if (settings.subagentsEnabled === false) return { mode: 'off' }
    return routePlan(kind, savedRoutes(settings)[kind])
  }

  /** Whether a kind of task now routes its subagents through the bridge. */
  bridges(kind) {
    return this.#plan(kind).mode === 'bridge'
  }

  /** The child a plan means, for a task `info` describes: who runs it and how it is shown. */
  #target(plan, info) {
    if (plan.target === 'dsh') {
      const { provider, model } = dshModelParts(plan.model)
      const tool = SUBAGENT_TOOLS[provider]
      return { kind: 'dsh', provider, model, effort: plan.effort, label: `${tool.family} ${model}`, note: tool.billing }
    }
    if (plan.target === 'cl') {
      const model = plan.model.slice(CLAUDE_PREFIX.length)
      return { kind: 'cl', model, effort: plan.effort, label: `Claude Code ${model}`, note: 'billed the way the user\'s Claude Code is' }
    }
    // A Codex task's own route may leave the model out: the child then runs the task's model.
    const model = plan.model ? plan.model.slice(CODEX_PREFIX.length) : info?.model ?? null
    return { kind: 'gp', model, effort: plan.model ? plan.effort : plan.effort ?? info?.effort ?? null, label: model ? `Codex ${model}` : 'Codex (the model you run on)', note: 'covered by the user\'s Codex sign-in' }
  }

  /**
   * The MCP server a task of `kind` mounts (ACP's stdio shape), or null when
   * its subagents do not go through the bridge.
   */
  mcpServer(kind, id, workspace) {
    if (!this.secret) return null
    const plan = this.#plan(kind)
    if (plan.mode !== 'bridge') return null
    const { label, note } = this.#target(plan, this.parents[kind](id))
    return {
      name: BRIDGE_MCP_SERVER,
      command: process.execPath,
      args: [mcpScript, '--workspace', workspace, '--label', label, '--note', note],
      env: [
        { name: 'AGENT_DESK_HOME', value: this.paths.home },
        { name: 'AGENT_DESK_SUBAGENT_URL', value: this.url() },
        { name: 'AGENT_DESK_SUBAGENT_PARENT', value: `${kind}:${id}` },
        { name: 'AGENT_DESK_SUBAGENT_TOKEN', value: this.#token(kind, id) },
        // dsh ends an MCP call after a minute (mcp-timeout-patch.js); Claude Code and Codex ignore this entry.
        { name: TIMEOUT_ENV, value: String(SUBAGENT_TOOL_TIMEOUT_SEC * 1000) },
      ],
    }
  }

  /** Runs one subagent for an authorized task; resolves with the child's answer, headed by who ran it. */
  async call({ parent, prompt, signal }) {
    const plan = this.#plan(parent.kind)
    if (plan.mode === 'off') throw new Error('Subagents are disabled in Agent Desk settings.')
    if (plan.mode !== 'bridge') throw new Error('This task\'s subagent setting changed. Use a task started after the change.')
    const info = this.parents[parent.kind](parent.id)
    if (!info) throw new Error('The task that started this subagent was not found.')
    const ran = this.#target(plan, info)
    const header = `Ran on: ${ran.label}${ran.effort ? ` (reasoning ${ran.effort})` : ''}`
    try {
      return `${header}\n\n${await this.#run(parent, ran, info, prompt, signal)}`
    } catch (error) {
      if (signal?.aborted) throw error
      const limit = isLeaderUsageLimit(error) ? '\nThe usage limit of this model was reached. Do not retry with the same settings.' : ''
      throw new Error(`${header}${limit}\n${error.message}`)
    }
  }

  async #run(parent, ran, info, prompt, signal) {
    if (ran.kind === 'dsh') {
      const patchFile = await this.dshPatch(parent.kind, { provider: ran.provider, model: ran.model, effort: ran.effort })
      return this.runDsh({ paths: this.paths, workspace: info.workspace, prompt, mode: info.mode, patchFile, signal })
    }
    if (ran.kind === 'cl') return this.#runClaude(ran, info, prompt, signal)
    return this.#runCodex(parent, ran, info, prompt, signal)
  }

  async #runClaude(ran, info, prompt, signal) {
    // Claude Code has no sandbox here, so a child is full access or read-only; a task between the two gets neither.
    if (info.mode === 'workspace-write') throw new Error('This task may only write in its working folder, so a Claude Code subagent (which runs unsandboxed) is not allowed. Give the task full access or choose another kind in the settings.')
    const session = await this.claude.create({
      workspace: info.workspace, model: ran.model, effort: ran.effort,
      args: abClaudeArgs({ writable: info.mode === 'danger-full-access', lean: false, instructions: `${CHILD_NOTE}\n\n${this.instructions()}` }),
    })
    try {
      const finished = finishedOf(this.claude, session.id)
      signal?.addEventListener('abort', () => this.claude.stop(session.id), { once: true })
      this.claude.run(session.id, prompt)
      return outcome(await finished)
    } finally {
      await this.claude.remove(session.id).catch(() => {})
    }
  }

  async #runCodex(parent, ran, info, prompt, signal) {
    const session = await this.codex.create({
      workspace: info.workspace, model: ran.model, effort: ran.effort, permissionMode: info.mode,
      instructions: CHILD_NOTE, mcpServers: {}, permissionPolicy: 'deny', subagent: { parent: `${parent.kind}:${parent.id}` },
    })
    try {
      const finished = finishedOf(this.codex, session.id)
      signal?.addEventListener('abort', () => void this.codex.stop(session.id).catch(() => {}), { once: true })
      this.codex.run(session.id, prompt)
      return outcome(await finished)
    } finally {
      await this.codex.remove(session.id).catch(() => {})
    }
  }
}
