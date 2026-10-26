// Open through Vite: /@fs/<repository>/test/fixtures/task-pinning-ui.html
// In DevTools: await pinTest.run(). RPC and persisted state are entirely mocked.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const requests: any[] = []
let fail = false
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    requests.push(input)
    setTimeout(() => {
      if (fail) {
        this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: false, error: 'fixture save failure' }) })
        return
      }
      const kind = input.type.split('.')[0]
      const list = kind === 'thread' ? server.threads : kind === 'terminal' ? server.terminals : server.ab
      const task = list.find((entry: any) => entry.id === (input.threadId ?? input.terminalId ?? input.runId))
      if (task && input.pinned !== undefined) {
        task.pinned = input.pinned
        persisted = structuredClone(server)
        store.setState({ server: structuredClone(server) })
      }
      this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result: { saved: true } }) })
    }, 0)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { Sidebar } = await import('../../web/src/components/Sidebar')
const workspace = 'C:/fixture'
const now = Date.now()
const base = { workspace, archived: false, createdAt: now - 10000, updatedAt: now - 10000, title: 'Fixture' }
let server: any = {
  app: { remote: false, myPc: workspace },
  settings: { workspaces: [], projectNames: {}, projectColors: {} },
  accounts: { chatgpt: { signedIn: false }, claude: { configured: false }, deepseek: { configured: false } },
  teams: [],
  threads: [
    ...Array.from({ length: 5 }, (_, i) => ({ ...base, id: 'recent-' + i, title: 'Recent ' + i, updatedAt: now - i, status: 'idle' })),
    { ...base, id: 'thread', title: 'Pinned conversation', status: 'running' },
    { ...base, id: 'gpt-team', title: 'Pinned GPT eco', status: 'idle', team: { id: 'eco', role: 'leader' } },
  ],
  terminals: [
    { ...base, id: 'terminal', title: 'Pinned Claude Code', state: 'stopped' },
    { ...base, id: 'team', title: 'Pinned Claude team', state: 'stopped', team: { id: 'team', role: 'leader' } },
  ],
  ab: [{ ...base, id: 'ab', title: 'Pinned AB', jobs: [], phase: 'completed' }],
}
let persisted = structuredClone(server)
store.setState({ server, route: { view: 'home' }, draft: { workspace: null, model: null, effort: '', permissionMode: 'read-only', toolMode: 'native' } })
store.connect()
const root = createRoot(document.getElementById('root')!)
let generation = 0
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 45))
const render = async () => { root.render(<div className="app-shell"><Sidebar key={++generation} /></div>); await tick() }
const check = (value: unknown, label: string) => { if (!value) throw new Error(label) }
const row = (title: string) => [...document.querySelectorAll<HTMLElement>('.thread-row')].find((row) => row.querySelector('.thread-title')?.textContent === title)!
const openMenu = async (title: string) => { row(title).querySelector<HTMLButtonElement>('.thread-actions button')!.click(); await tick() }
const choose = async (title: string, label: string) => {
  await openMenu(title)
  const item = [...row(title).querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find((item) => item.textContent === label)
  check(item, title + ': ' + label)
  item!.click(); await tick()
}
const visibleTitles = () => [...document.querySelectorAll('.thread-title')].map((item) => item.textContent)
const api = {
  requests, render,
  async run() {
    await render()
    check(visibleTitles().join('/') === 'Recent 0/Recent 1/Recent 2', 'initial recent quota')
    document.querySelector<HTMLButtonElement>('.task-more')!.click(); await tick()
    const titles = ['Pinned conversation', 'Pinned GPT eco', 'Pinned Claude Code', 'Pinned Claude team', 'Pinned AB']
    for (const title of titles) {
      await choose(title, 'ピン留め')
      check(!document.querySelector('[role=menu]'), title + ': menu closes')
      check(row(title).querySelector('[aria-label=ピン留め済み]'), title + ': pin marker')
    }
    check(requests.filter((request) => request.pinned === true).length === 5, 'all task types send pin updates')
    document.querySelector<HTMLButtonElement>('.task-more')!.click(); await tick()
    check(visibleTitles().length === 8, 'collapsed pins plus three recent tasks')
    server = structuredClone(persisted)
    store.setState({ server }); await render()
    check(visibleTitles().length === 8, 'pins survive simulated reload')
    check(document.querySelectorAll('.thread-pin').length === 5, 'all reloaded pins have markers')
    fail = true
    await choose('Pinned conversation', 'ピン留めを解除')
    check(row('Pinned conversation').querySelector('.thread-pin'), 'save failure keeps pin')
    check(store.getState().toasts.at(-1)?.tone === 'error', 'save failure is reported')
    fail = false
    for (const title of titles) await choose(title, 'ピン留めを解除')
    check(document.querySelectorAll('.thread-pin').length === 0, 'all pins removed')
    check(visibleTitles().join('/') === 'Recent 0/Recent 1/Recent 2', 'unpin restores recency and quota')
    return ['five task variants pin/unpin', 'menu closes and pin markers', 'pins outside collapsed quota', 'simulated reload', 'save failure retains pin and reports error']
  },
}
Object.assign(window, { pinTest: api })
await render()
