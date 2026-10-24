import { EventEmitter } from 'node:events'
import { AB_CONSULT } from './ab.js'

export function abClaudeArgs({ writable, lean, instructions }) {
  return ['--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--no-chrome',
    '--disallowedTools', 'Agent,Task,Workflow,SendMessage,RemoteTrigger,CronCreate,ScheduleWakeup,AskUserQuestion,EnterPlanMode,ExitPlanMode',
    ...(!writable ? ['--tools', lean ? 'Read,Glob,Grep' : 'Read,Glob,Grep,WebSearch,WebFetch'] : []),
    '--append-system-prompt', instructions]
}

export class AbRunner extends EventEmitter {
  constructor({ threads, agents, instructions = () => '', guard = () => {} }) {
    super()
    this.threads = threads
    this.agents = agents
    this.instructions = instructions
    this.guard = guard
    this.owned = new Map()
    threads.on('turn-finished', ({ threadId, status }) => {
      const owner = this.owned.get(threadId)
      if (!owner) return
      void threads.get(threadId).then(({ turns }) => {
        const turn = turns.at(-1)
        this.emit('finished', { ...owner, status: status === 'done' ? 'completed' : status,
          text: turn?.items?.filter((item) => item.type === 'agent').at(-1)?.text ?? '', error: turn?.error?.message })
      }).catch((error) => this.emit('finished', { ...owner, status: 'error', error: error.message }))
    })
    agents.on('finished', ({ id, status, text, error }) => {
      const owner = this.owned.get(id)
      if (owner) this.emit('finished', { ...owner, status: status === 'done' ? 'completed' : status, text, error })
    })
    threads.on('approval-needed', ({ threadId, requestId }) => {
      if (this.owned.has(threadId)) void threads.respondPermission(requestId, null).catch(() => {})
    })
  }
  async start(input) {
    const { runId, jobId, model, workspace, text, writable, lean, instructions } = input
    this.guard({ workspace })
    const owner = { runId, jobId }
    if (model.startsWith('claude:')) {
      const session = await this.agents.create({ workspace, model: model.slice(7),
        args: abClaudeArgs({ writable, lean, instructions: `${instructions}\n\n${this.instructions()}` }) })
      this.owned.set(session.id, owner)
      try { this.agents.run(session.id, text) } catch (error) { this.owned.delete(session.id); throw error }
      return { kind: 'claude', id: session.id }
    }
    const thread = await this.threads.create({ workspace, model, permissionMode: writable ? 'workspace-write' : 'read-only',
      ab: { runId, jobId, writable, lean } })
    this.owned.set(thread.id, owner)
    try {
      // Consultation user content is not rewritten or prefixed by a leader.
      await this.threads.send(thread.id, { text: instructions === AB_CONSULT ? text : `${instructions}\n\n${text}` })
    } catch (error) { this.owned.delete(thread.id); throw error }
    return { kind: 'thread', id: thread.id }
  }
  async remove(handle) {
    this.owned.delete(handle.id)
    if (handle.kind === 'claude') await this.agents.remove(handle.id)
    else if (this.threads.threads.has(handle.id)) await this.threads.remove(handle.id)
  }
  async stop(handle) {
    if (!handle) return
    if (handle.kind === 'claude') await this.agents.stop(handle.id)
    else await this.threads.cancel(handle.id)
  }
}
