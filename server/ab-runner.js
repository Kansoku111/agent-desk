import { EventEmitter } from 'node:events'
import { AB_CONSULT, abJobPermission } from './ab.js'
import { describeTool } from './teams-prompts.js'

export function abClaudeArgs({ writable, lean, instructions }) {
  return ['--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--no-chrome',
    '--disallowedTools', 'Agent,Task,Workflow,SendMessage,RemoteTrigger,CronCreate,ScheduleWakeup,AskUserQuestion,EnterPlanMode,ExitPlanMode',
    ...(!writable ? ['--tools', lean ? 'Read,Glob,Grep' : 'Read,Glob,Grep,WebSearch,WebFetch'] : []),
    '--append-system-prompt', instructions]
}

export class AbRunner extends EventEmitter {
  constructor({ threads, agents, instructions = () => '', guard = () => {}, stopTimeoutMs = 10_000 }) {
    super()
    this.threads = threads
    this.agents = agents
    this.instructions = instructions
    this.guard = guard
    this.stopTimeoutMs = stopTimeoutMs
    this.owned = new Map()
    threads.on('turn-finished', ({ threadId, status }) => {
      const owner = this.owned.get(threadId)
      if (!owner) return
      this.owned.delete(threadId)
      void threads.get(threadId).then(({ turns }) => {
        const turn = turns.at(-1)
        this.emit('finished', { runId: owner.runId, jobId: owner.jobId, status: status === 'done' ? 'completed' : status,
          text: turn?.items?.filter((item) => item.type === 'agent').at(-1)?.text ?? '', error: turn?.error?.message,
          denials: owner.denials, ...(owner.writable ? { blockers: (turn?.items ?? [])
            .filter((item) => item.type === 'tool' && item.status === 'failed' && /SetNamedSecurityInfoW failed \(Win32 5\)/i.test(item.output ?? ''))
            .map((item) => `${describeTool(item.name, item.input)}\n${item.output}`) } : {}) })
      }).catch((error) => this.emit('finished', { runId: owner.runId, jobId: owner.jobId, status: 'error', error: error.message, denials: owner.denials }))
    })
    agents.on('finished', ({ id, status, text, error, denials }) => {
      const owner = this.owned.get(id)
      if (!owner) return
      this.owned.delete(id)
      this.emit('finished', { runId: owner.runId, jobId: owner.jobId, status: status === 'done' ? 'completed' : status, text, error,
        denials: (denials ?? []).map((entry) => describeTool(entry?.tool_name, entry?.tool_input)) })
    })
    // The event carries NO requestId. Read the registered pending requests;
    // respondPermission is synchronous and must not be treated as a Promise.
    threads.on('approval-needed', ({ threadId }) => {
      const owner = this.owned.get(threadId)
      if (!owner) return
      for (const request of threads.pendingPermissions(threadId)) {
        if (owner.deniedIds.has(request.requestId)) continue
        owner.denials.push(describeTool(request.name, request.input))
        owner.deniedIds.add(request.requestId)
        try {
          threads.respondPermission(request.requestId, null)
        } catch (error) {
          // Cancellation is a final backstop; never leave an invisible worker
          // waiting forever if the permission transport rejects the response.
          void this.stop({ kind: 'thread', id: threadId }).catch((stopError) => this.emit('fault', stopError))
          this.emit('fault', error)
        }
      }
    })
  }
  async start(input) {
    const { runId, jobId, model, workspace, text, writable, lean, instructions } = input
    this.guard({ workspace })
    const owner = { runId, jobId, writable, denials: [], deniedIds: new Set() }
    if (model.startsWith('claude:')) {
      const session = await this.agents.create({ workspace, model: model.slice(7),
        args: abClaudeArgs({ writable, lean, instructions: `${instructions}\n\n${this.instructions()}` }) })
      this.owned.set(session.id, owner)
      try { this.agents.run(session.id, text) } catch (error) {
        this.owned.delete(session.id)
        await this.agents.remove(session.id)
        throw error
      }
      return { kind: 'claude', id: session.id }
    }
    const thread = await this.threads.create({ workspace, model, permissionMode: abJobPermission(writable),
      ab: { runId, jobId, writable, lean } })
    this.owned.set(thread.id, owner)
    try {
      // Consultation user content is not rewritten or prefixed by a leader.
      await this.threads.send(thread.id, { text: instructions === AB_CONSULT ? text : `${instructions}\n\n${text}` })
    } catch (error) {
      this.owned.delete(thread.id)
      await this.threads.remove(thread.id)
      throw error
    }
    return { kind: 'thread', id: thread.id }
  }
  async remove(handle) {
    await this.stop(handle)
    this.owned.delete(handle.id)
    if (handle.kind === 'claude') await this.agents.remove(handle.id)
    else if (this.threads.threads.has(handle.id)) await this.threads.remove(handle.id)
  }
  async stop(handle) {
    if (!handle) return
    // A stop request is not proof that the process is idle. Wait for its
    // existing completion barrier before admitting any retry or deletion.
    let timer
    const stopped = async () => {
      if (handle.kind === 'claude') {
        const exited = this.agents.live.get(handle.id)?.exited
        this.agents.stop(handle.id)
        await exited
      } else {
        const done = this.threads.active.get(handle.id)?.done
        await this.threads.cancel(handle.id)
        await done
      }
    }
    try {
      await Promise.race([stopped(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('担当プロセスの停止確認がタイムアウトしました')), this.stopTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
}
