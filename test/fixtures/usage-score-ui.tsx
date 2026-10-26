// Local Vite fixture: no providers, real files, or application state are touched.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result: { git: null } }) }))
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { ThreadView } = await import('../../web/src/components/ThreadView')
const { TerminalChat } = await import('../../web/src/components/TerminalChat')
const { AbView } = await import('../../web/src/components/Ab')
const model = '["openai-codex","fixture"]'
const score = (points: number, unpriced = 0) => ({ points, priced: 1, unpriced })
const thread: any = { id: 'task', title: 'API換算ドルの表示確認', workspace: 'C:\\fixture', model, effort: '', permissionMode: 'workspace-write', status: 'idle', usage: null, updatedAt: 1 }
const turns: any[] = [1, 2].map((points, index) => ({ id: `t${index}`, status: 'done', startedAt: 1, endedAt: 1001,
  user: { text: index ? '続けてください' : '設定の保存処理を修正してください', images: [] },
  items: [{ type: 'agent', id: `a${index}`, text: '修正し、テストで保存と復元を確認しました。' }],
  usage: { requests: 1, input: 2000, output: 174, cacheRead: 376000, cacheWrite: 0, reasoning: 0, cost: null, models: ['openai-codex/fixture'], score: score(points) },
}))
const server: any = {
  app: { remote: false, myPc: 'C:\\fixture', platform: 'win32' }, openTargets: {},
  settings: { agentTeams: {}, modelVisibility: {}, projectNames: {} },
  accounts: { chatgpt: { signedIn: true }, claude: { configured: false }, deepseek: { configured: false } },
  catalog: { providers: { 'openai-codex': 'ChatGPT' }, models: [{ value: model, provider: 'openai-codex', id: 'fixture', name: 'Fixture' }], effortsByModel: {}, fallbackEfforts: [] },
  threads: [thread], terminals: [], teams: [], ab: [], permissionModes: ['read-only', 'workspace-write'], fastModels: {},
}
store.setState({ server, turns: { task: turns }, sidebarOpen: true, teamPanel: false })
store.connect()
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60))
const team = (points: number, kind = 'thread', eco = false): any => ({
  id: 'team', workspace: thread.workspace, leaderId: 'task', leaderKind: kind, score: score(points), children: [], queue: [], approvals: [], asks: [], delivery: 'idle',
  ...(eco ? { execution: { stopped: false, metrics: { childTurns: 1, parentTurns: 1, parentReports: 1, verifications: 1, repairs: 0 } } } : {}),
})
let generation = 0
const render = async (kind: string) => {
  server.teams = kind === 'TM' ? [team(30)] : kind === 'eco' ? [team(40, 'thread', true)] : kind === 'CL' ? [team(50, 'terminal')] : []
  server.ab = [{ id: 'ab', workspace: thread.workspace, title: 'ABの累計', text: '相談', config: { a: model, b: model, leader: model, implementer: model, delegate: true, review: true },
    phase: 'reviewed', revision: 1, plan: 'plan', messages: [], score: score(60),
    jobs: [{ id: 'j1', role: 'a', model, status: 'completed', report: 'Aの報告', score: score(1) },
      { id: 'j2', role: 'b', model, status: 'completed', report: 'Bの報告', score: score(2) },
      { id: 'j3', role: 'reviewer', model, status: 'completed', report: 'レビューしました。', score: score(3) }],
  }]
  const current = kind === 'partial' ? [{ ...turns[0], usage: { ...turns[0].usage, score: score(1.234, 1) } }]
    : kind === 'unknown' ? [{ ...turns[0], usage: { ...turns[0].usage, score: { points: 0, priced: 0, unpriced: 1 } } }]
    : ['small', 'tiny', 'zero'].includes(kind) ? [{ ...turns[0], usage: { ...turns[0].usage, score: score(kind === 'small' ? 21.67 : kind === 'tiny' ? 0.00005 : 0) } }]
    : kind === 'billed' ? turns.map((turn, index) => ({ ...turn, usage: { ...turn.usage, cost: (index + 1) * 0.002, models: ['anthropic/fixture'] } })) : turns
  store.setState({ server: { ...server }, turns: { task: current } })
  const terminal: any = { ...thread, state: 'stopped', activity: 'idle', score: score(3) }
  root.render(kind === 'AB' ? <AbView key={++generation} id="ab" /> : kind === 'CL' ? <TerminalChat key={++generation} terminal={terminal} turns={turns} omitted={0} loaded error={null} onShowScreen={() => {}} onRestart={() => {}} /> : <ThreadView key={++generation} threadId="task" />)
  await tick()
}
const api = {
  render,
  async run() {
    const passed: string[] = []
    for (const [kind, expected] of [['normal', 'API換算 $0.006'], ['TM', 'API換算 $0.06'], ['eco', 'API換算 $0.08'],
      ['CL', 'API換算 $0.10'], ['AB', 'API換算 $0.12'], ['partial', 'API換算 ≥ $0.002468'], ['unknown', 'API換算 —'],
      ['small', 'API換算 $0.04334'], ['tiny', 'API換算 < $0.000001'], ['zero', 'API換算 $0.00'], ['billed', 'API換算 $0.006']]) {
      await render(kind)
      const costs = [...document.querySelectorAll<HTMLElement>('.usage-cost')]
      if (costs.at(-1)?.textContent?.trim() !== expected) throw new Error(`${kind}: expected ${expected}, got ${costs.at(-1)?.textContent}`)
      if (!costs.at(-1)?.title.includes('サブスク')) throw new Error(`${kind}: missing equivalent cost explanation`)
      if (kind !== 'AB' && !document.querySelector('.usage-line')?.textContent?.includes('入力')) throw new Error(`${kind}: original token counts disappeared`)
      if (kind === 'normal' && costs[0]?.textContent?.trim() !== 'API換算 $0.002') throw new Error('historical cumulative USD')
      if (costs.some((element) => element.getBoundingClientRect().width > innerWidth)) throw new Error(`${kind}: overflow`)
      for (const line of document.querySelectorAll('.usage-line')) {
        if ((line.textContent?.match(/\$/g) ?? []).length > 1 || line.textContent?.includes(' pt')) throw new Error(`${kind}: duplicated or stale currency display`)
      }
      if (kind === 'billed') {
        const footer = [...document.querySelectorAll<HTMLElement>('.usage-line')].at(-1)!
        if (!footer.title.includes('このターンの従量課金概算 $0.0040') || !footer.title.includes('このセッションの従量課金概算累計 $0.0060')) {
          throw new Error('metered estimates must remain available in detail, separate from cumulative API equivalent')
        }
      }
      passed.push(kind)
    }
    await render('eco')
    return { passed, viewport: `${innerWidth}x${innerHeight}` }
  },
}
Object.assign(window, { usageScoreTest: api })
await render('normal')
