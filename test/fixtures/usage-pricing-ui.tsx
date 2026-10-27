// Local Vite fixture: a fake socket and fixed usage totals only; no providers, files, or app state are touched.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

let usage: any = null
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result: { usage } }) }))
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { UsagePanel } = await import('../../web/src/components/UsagePanel')

const pad = (value: number) => String(value).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const totals = (requests: number, input: number, cost: number | null, unpriced: number, output = 0) =>
  ({ requests, input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost, unpriced })

// One model row per scenario, with the labels the panel must show (tiles, model row, chart title).
const scenarios: Record<string, { row: [string, any] | null; tile: string; cell: string; bar: string }> = {
  unknown: { row: ['anthropic/new-model', totals(2, 3000, null, 2, 200)], tile: '—', cell: '—', bar: '—' },
  mixed: { row: ['anthropic/claude-sonnet-5-5', totals(3, 5000, 1.5, 1, 100)], tile: '≥ $1.50', cell: '≥ $1.50', bar: '≥ $1.50' },
  subscription: { row: ['openai-codex/gpt-5.5', totals(4, 8000, null, 0, 300)], tile: '約 $0', cell: '—', bar: '約 $0' },
  none: { row: null, tile: '約 $0', cell: '', bar: '約 $0' },
  'known-zero': { row: ['anthropic/free-model', totals(1, 1000, 0, 0)], tile: '約 $0', cell: '$0', bar: '約 $0' },
}

const localFor = (row: [string, any] | null) => {
  const t = row ? row[1] : totals(0, 0, null, 0)
  return {
    today: t, month: t, all: t, since: today,
    providers: row ? { [row[0].split('/')[0]]: { today: t, month: t, all: t } } : {},
    models: row ? [{ model: row[0], month: t, all: t }] : [],
    daily: [{ day: today, cost: t.cost ?? 0, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, unpriced: t.unpriced }],
    updatedAt: Date.now(),
  }
}

let server: any = {
  accounts: { claude: { configured: false }, claudeAdmin: { configured: false, masked: null } },
}
let generation = 0
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60))
const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
const localCard = () => [...document.querySelectorAll<HTMLElement>('section.account-card')]
  .find((section) => section.querySelector('h3')?.textContent === 'Agent Desk での使用量（概算）')

async function show(name: string) {
  usage = { local: localFor(scenarios[name].row), claude: { status: 'none', source: null, fetchedAt: null, message: null, summary: null } }
  server = { ...server, usage }
  store.setState({ server })
  root.render(<UsagePanel key={++generation} />)
  await tick()
}

const api = {
  show,
  async run() {
    const passed: string[] = []
    for (const [name, scenario] of Object.entries(scenarios)) {
      await show(name)
      const card = localCard()
      if (!card) throw new Error(`${name}: usage card not rendered`)
      const tiles = Object.fromEntries([...card.querySelectorAll('.usage-tile')]
        .map((tile): [string, string] => [text(tile.querySelector('.usage-tile-label')), text(tile.querySelector('.usage-tile-value'))]))
      for (const label of ['今日', '今月', '全期間']) {
        if (tiles[label] !== scenario.tile) throw new Error(`${name} tile ${label}: expected ${scenario.tile}, got ${tiles[label]}`)
      }
      if (scenario.row) {
        const cell = text(card.querySelector('table.usage-table tbody tr td:nth-child(5)'))
        if (cell !== scenario.cell) throw new Error(`${name} model row: expected ${scenario.cell}, got ${cell}`)
      } else if (!text(card).includes('この期間の利用はありません。')) {
        throw new Error(`${name}: empty-usage message missing`)
      }
      const bar = [...card.querySelectorAll<HTMLElement>('.usage-bar')].map((element) => element.title).find((title) => title.startsWith(`${today}:`))
      if (!bar?.includes(`: ${scenario.bar} · `)) throw new Error(`${name} chart: expected ${scenario.bar} in "${bar}"`)
      passed.push(name)
    }
    return { passed, viewport: `${innerWidth}x${innerHeight}` }
  },
}
Object.assign(window, { usagePricingTest: api })
await show('mixed')
