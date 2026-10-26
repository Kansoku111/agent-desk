// Local Vite fixture: no providers, real files, or application state are touched.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

let failNextSave = false
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    queueMicrotask(() => {
      if (input.type === 'settings.update') {
        if (failNextSave) {
          failNextSave = false
          this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: false, error: 'fixture save failed' }) })
          return
        }
        server.settings = { ...server.settings, ...input.patch }
        store.setState({ server: { ...server } })
      }
      this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result: { git: null } }) })
    })
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { ThreadView } = await import('../../web/src/components/ThreadView')
const { TerminalChat } = await import('../../web/src/components/TerminalChat')
const { AbView } = await import('../../web/src/components/Ab')
const { SettingsDialog } = await import('../../web/src/components/Settings')
const model = '["openai-codex","fixture"]'
const score = (points: number, unpriced = 0) => ({ points, priced: 1, unpriced })
const thread: any = { id: 'task', title: 'API換算額の表示確認', workspace: 'C:\\fixture', model, effort: '', permissionMode: 'workspace-write', status: 'idle', usage: null, updatedAt: 1 }
const turns: any[] = [1, 2].map((points, index) => ({ id: `t${index}`, status: 'done', startedAt: 1, endedAt: 1001,
  user: { text: index ? '続けてください' : '設定の保存処理を修正してください', images: [] },
  items: [{ type: 'agent', id: `a${index}`, text: '修正し、テストで保存と復元を確認しました。' }],
  usage: { requests: 1, input: 2000, output: 174, cacheRead: 376000, cacheWrite: 0, reasoning: 0, cost: null, models: ['openai-codex/fixture'], score: score(points) },
}))
const server: any = {
  app: { remote: false, myPc: 'C:\\fixture', platform: 'win32' }, openTargets: {},
  settings: { agentTeams: {}, modelVisibility: {}, projectNames: {}, theme: 'light', defaultPermissionMode: 'workspace-write',
    notifications: false, browserTool: false, desktopTool: false, imageTool: false, checkpoints: true, usageCurrency: 'USD', usdJpyRate: null },
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
    : ['billed', 'legacy'].includes(kind) ? turns.map((turn, index) => ({ ...turn, usage: { ...turn.usage,
      ...(kind === 'legacy' ? { score: undefined } : {}), cost: (index + 1) * 0.002, models: ['anthropic/fixture'] } })) : turns
  store.setState({ server: { ...server }, turns: { task: current } })
  const terminal: any = { ...thread, state: 'stopped', activity: 'idle', score: score(3) }
  root.render(kind === 'AB' ? <AbView key={++generation} id="ab" /> : kind === 'CL' ? <TerminalChat key={++generation} terminal={terminal} turns={turns} omitted={0} loaded error={null} onShowScreen={() => {}} onRestart={() => {}} /> : <ThreadView key={++generation} threadId="task" />)
  await tick()
}
const api = {
  render,
  setDisplay(usageCurrency: 'USD' | 'JPY', usdJpyRate: number | null) {
    server.settings = { ...server.settings, usageCurrency, usdJpyRate }
    store.setState({ server: { ...server } })
  },
  settings: () => structuredClone(server.settings),
  failSave: () => { failNextSave = true },
  async renderSettings() {
    root.render(<SettingsDialog key={++generation} tab="general" />)
    await tick()
  },
  async run(currency: 'USD' | 'JPY' = 'USD') {
    api.setDisplay(currency, 150)
    const before = JSON.stringify(turns)
    const passed: string[] = []
    for (const [kind, usd, jpy] of [['normal', '$0.006', '¥0.9'], ['TM', '$0.06', '¥9'], ['eco', '$0.08', '¥12'],
      ['CL', '$0.10', '¥15'], ['AB', '$0.12', '¥18'], ['partial', '≥ $0.002468', '≥ ¥0.3702'], ['unknown', '—', '—'],
      ['small', '$0.04334', '¥6.501'], ['tiny', '< $0.000001', '¥0.000015'], ['zero', '$0.00', '¥0'],
      ['billed', '$0.006', '¥0.9'], ['legacy', '—', '—']]) {
      const expected = `API換算 ${currency === 'JPY' ? jpy : usd}`
      await render(kind)
      const costs = [...document.querySelectorAll<HTMLElement>('.usage-cost')]
      if (costs.at(-1)?.textContent?.trim() !== expected) throw new Error(`${kind}: expected ${expected}, got ${costs.at(-1)?.textContent}`)
      if (!costs.at(-1)?.title.includes('サブスク')) throw new Error(`${kind}: missing equivalent cost explanation`)
      if (kind !== 'AB' && !document.querySelector('.usage-line')?.textContent?.includes('入力')) throw new Error(`${kind}: original token counts disappeared`)
      if (kind === 'normal' && costs[0]?.textContent?.trim() !== `API換算 ${currency === 'JPY' ? '¥0.3' : '$0.002'}`) throw new Error('historical cumulative amount')
      if (costs.some((element) => element.getBoundingClientRect().width > innerWidth)) throw new Error(`${kind}: overflow`)
      for (const line of document.querySelectorAll('.usage-line')) {
        if ((line.textContent?.match(/[$¥]/g) ?? []).length > 1 || line.textContent?.includes(' pt')) throw new Error(`${kind}: duplicated or stale currency display`)
      }
      if (kind === 'billed' || kind === 'legacy') {
        const trigger = costs.at(-1)!
        trigger.focus()
        trigger.click()
        await tick()
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
        if (!dialog?.textContent?.includes('このターンの従量課金概算 $0.0040') || !dialog.textContent.includes('このセッションの従量課金概算累計 $0.0060')) {
          throw new Error('metered estimates must be readable in an opened detail, including legacy records')
        }
        if (currency === 'JPY' && !dialog.textContent.includes('手動レート 1 USD = 150 JPY')) throw new Error('missing manual exchange rate')
        dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click()
        await tick()
        if (document.activeElement !== trigger) throw new Error('detail must return focus to its trigger')
      }
      passed.push(kind)
    }
    if (JSON.stringify(turns) !== before) throw new Error('currency conversion mutated saved usage')
    await render('eco')
    return { currency, passed, viewport: `${innerWidth}x${innerHeight}` }
  },
}
Object.assign(window, { usageScoreTest: api })
await render('normal')
