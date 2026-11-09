// Open via Vite (node test/fixtures/serve-ab-ui.mjs): /@fs/<repository>/test/fixtures/subagent-panel-ui.html?t=fixture
// A Codex (GP) task whose subagents ran as another kind of task: they show in the right-hand panel,
// and a frame for a running one updates its card. No real models, files or server state are touched.
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const now = Date.now()
const usage = { requests: 3, input: 4200, output: 310, cacheRead: 1000, cacheWrite: 0, cost: null }
const card = (id: string, extra: object) => ({
  id, parentId: null, depth: 1, callId: null, label: null, mode: 'one-shot', title: null, provider: null, model: null, effort: null,
  status: 'done', startedAt: now - 60_000, updatedAt: now - 20_000, endedAt: now - 20_000, prompt: '', items: [], usage, ...extra,
})
const cards = [
  card('claude', {
    modelName: 'Claude Code haiku', effort: 'low', prompt: 'テストです。作業ディレクトリを確認して報告してください。',
    items: [
      { type: 'tool', id: 'c1', name: 'Bash', kind: 'execute', status: 'completed', input: { command: 'pwd' }, output: 'F:\\Agent-Desk-DSH', startedAt: now - 50_000 },
      { type: 'agent', id: 'a1', text: '作業ディレクトリは `F:\\Agent-Desk-DSH` です。ファイル変更はありません。' },
    ],
  }),
  card('dsh', { modelName: 'GPT gpt-6-luna', effort: 'high', status: 'running', startedAt: now - 5_000, endedAt: null, prompt: '差分をレビューして', usage: { ...usage, requests: 0 } }),
]
const task: any = { id: 'gp', title: 'テストです。サブエージェントを呼んでみて', workspace: 'C:\\fixture', model: 'gpt-6-luna', effort: 'low', permissionMode: 'danger-full-access', sessionId: null, status: 'idle', pendingApproval: false, createdAt: 1, updatedAt: 1, archived: false, pinned: false }

class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    let result: any = {}
    if (input.type === 'codex.task.get') result = { task, turns: [], permissions: [] }
    if (input.type === 'subagents.list') result = { subagents: cards }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result }) }), 0)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { CodexView } = await import('../../web/src/components/CodexView')
const server: any = { app: { remote: false }, openTargets: { terminal: true }, settings: { agentTeams: {}, modelVisibility: {} }, accounts: {}, catalog: { models: [], providers: {}, fallbackEfforts: [], effortsByModel: {} }, threads: [], terminals: [], teams: [], codexTasks: [task], codexModels: [] }
store.setState({ server, subagentPanel: true, route: { view: 'codex', id: 'gp' } })
store.connect()
await store.loadSubagents('gp')
createRoot(document.getElementById('root')!).render(<CodexView taskId="gp" />)
Object.assign(window, { subagentFixture: { store } })
