// Open via Vite: /@fs/<repository>/test/fixtures/ab-ui.html?t=fixture
// No real models, files or server state are touched. In DevTools: await abTest.run(), or await abTest.openMenus() for menu-only checks.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const requests: any[] = []
let fail = '', delay = '', release: (() => void) | undefined
const model = '["openai-codex","fixture"]'
const config = { a: model, b: model, leader: model, implementer: model, efforts: { a: '', b: '', leader: '', implementer: '' }, lean: true, delegate: false, review: false }
let savedModels = { leader: model, provider: 'gpt', model: 'fixture', leaderEffort: '', childEffort: '' }
const image = { file: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', mimeType: 'image/png', name: 'fixture.png' }
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body); requests.push(input)
    const reply = () => {
      let result: any = { saved: true }
      if (input.type === 'ab.config') result = { config }
      if (input.type === 'ab.create') result = { run }
      if (input.type === 'team.create') result = { team: { id: 'fixture-team' } }
      if (input.type === 'attachment.add') result = image
      if (input.type === 'execution.checks') result = { checks: [] }
      if (input.type === 'execution.models') result = { models: savedModels }
      if (input.type === 'execution.setModels') { savedModels = input.models; result = { models: savedModels } }
      this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: fail !== input.type, result, error: 'fixture failure' }) })
    }
    if (delay === input.type) release = reply
    else setTimeout(reply, 0)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { AbStartDialog, AbView } = await import('../../web/src/components/Ab')
const { ThreadView } = await import('../../web/src/components/ThreadView')
const { ExecutionStartDialog } = await import('../../web/src/components/ExecutionSettings')
const run = { id: 'run', workspace: 'C:\\fixture', title: 'Fixture', text: 'original', images: [image], config, phase: 'completed', revision: 1, plan: 'plan', jobs: [], messages: [{ text: 'follow-up', images: [image] }], createdAt: 1, updatedAt: 1 }
const server: any = { app: { remote: false }, openTargets: { terminal: true }, settings: { agentTeams: {}, modelVisibility: {} }, accounts: { chatgpt: { signedIn: true }, claude: { configured: false }, deepseek: { configured: false } }, catalog: { models: [{ value: model, id: 'fixture', provider: 'openai-codex', name: 'Fixture GPT' }], providers: { 'openai-codex': 'ChatGPT' }, fallbackEfforts: [], effortsByModel: { [model]: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] } }, ab: [run] }
const thread: any = { id: 'thread', workspace: 'C:\\作業 folder\\project', title: 'Thread fixture', model, effort: '', permissionMode: 'read-only', status: 'idle', updatedAt: 1 }
server.threads = [thread]
server.teams = []
store.setState({ server })
store.connect()
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 35))
let generation = 0
const render = async (kind: string) => { root.render(kind === 'start' ? <AbStartDialog key={++generation} workspace="C:\fixture" /> : kind === 'eco' ? <ExecutionStartDialog key={++generation} workspace="C:\fixture" /> : kind === 'thread' ? <ThreadView key={++generation} threadId="thread" /> : <AbView key={++generation} id="run" />); await tick() }
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label) }
const input = () => document.querySelector('textarea')!
const text = async (value: string) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); await tick() }
const key = async (options: KeyboardEventInit = {}) => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })); await tick() }
const count = (type: string) => requests.filter((request) => request.type === type).length
const paste = async () => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([await (await fetch(imageUrl)).blob()], 'fixture.png', { type: 'image/png' }))
  input().dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  await tick()
}
const select = async (label: string, value: string) => { const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); await tick() }
const openMenu = async () => {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('header button')].find((button) => button.textContent?.trim() === '開く')
  check(trigger, 'shared open menu trigger')
  trigger!.click(); await tick()
  const menu = document.querySelector<HTMLElement>('header [role="menu"]')
  check(menu, 'shared open menu panel')
  return { trigger: trigger!, menu: menu! }
}
const choose = async (label: string) => {
  const { menu } = await openMenu()
  const item = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes(label))
  check(item, `shared open menu item: ${label}`)
  item!.click(); await tick()
}
const api = {
  requests, render,
  async openMenus() {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writes: string[] = []
    let rejectCopy = false
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      writes.push(value)
      if (rejectCopy) throw new Error('fixture clipboard denied')
    } } })
    const passed: string[] = []
    const label = '作業フォルダーのパスをコピー'
    try {
      await render('view')
      const { trigger, menu } = await openMenu()
      const header = document.querySelector('.ab-header')!.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      check(triggerRect.left >= header.left && triggerRect.right <= header.right + 0.5, 'AB open trigger inside header')
      check(menuRect.left >= 0 && menuRect.right <= innerWidth && menuRect.top >= 0 && menuRect.bottom <= innerHeight, 'AB open menu fits viewport')
      const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
      check(labels.join('/') === 'ターミナル/作業フォルダーのパスをコピー/ビルドして再起動', 'AB open menu item order')
      const beforeOpen = count('workspace.open')
      ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('ターミナル'))!.click()
      await tick()
      const opened = requests.filter((request) => request.type === 'workspace.open')
      check(opened.length === beforeOpen + 1 && opened.at(-1).path === 'C:\\fixture' && opened.at(-1).target === 'terminal', 'AB open terminal sends run workspace / terminal')
      check(!document.querySelector('.ab-header [role="menu"]'), 'AB open menu closes after terminal')
      const opensAfterTerminal = count('workspace.open')
      await choose('ビルドして再起動')
      check(store.getState().restartConfirm === true, 'AB restart asks for confirmation')
      check(count('workspace.open') === opensAfterTerminal && count('app.restart') === 0 && count('restart') === 0, 'AB restart does not run anything yet')
      store.setState({ restartConfirm: false })
      store.setState({ server: { ...server, app: { ...server.app, remote: true } } })
      await render('view')
      check(![...document.querySelectorAll('.ab-header button')].some((button) => button.textContent?.trim() === '開く'), 'AB open menu hidden on remote')
      store.setState({ server })
      await render('view')
      check([...document.querySelectorAll('.ab-header button')].some((button) => button.textContent?.trim() === '開く'), 'AB open menu shown on local')
      passed.push('AB open menu: terminal target / restart confirmation only / hidden on remote')
      for (const kind of ['view', 'thread']) {
        for (const terminal of [true, false, undefined]) {
          store.setState({ server: { ...server, openTargets: terminal === undefined ? undefined : { terminal } }, toasts: [] })
          await render(kind)
          const { menu } = await openMenu()
          const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
          check(labels.join('/') === (terminal ? 'ターミナル/' : '') + label + '/ビルドして再起動', kind + ' menu order / terminal availability')
          const item = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === label)!
          const text = item.querySelector<HTMLElement>('.menu-label')!
          check(text.scrollWidth <= text.clientWidth, kind + ' copy label fits one line')
          check(item.querySelector('svg') && !item.querySelector('.menu-description'), kind + ' copy icon without description')
          const beforeRequests = requests.length, beforeWrites = writes.length
          item.click(); await tick()
          check(writes.length === beforeWrites + 1 && writes.at(-1) === (kind === 'thread' ? thread.workspace : run.workspace), kind + ' copies only exact workspace path')
          check(!document.querySelector('header [role="menu"]'), kind + ' copy closes menu')
          check(requests.length === beforeRequests, kind + ' copy makes no RPC request')
          const notification = store.getState().toasts.at(-1)
          check(notification?.text === 'パスをコピーしました' && notification.tone === 'success', kind + ' copy success notification')
        }
        rejectCopy = true
        store.setState({ toasts: [] })
        await choose(label)
        check(!document.querySelector('header [role="menu"]'), kind + ' failed copy closes menu')
        const notification = store.getState().toasts.at(-1)
        check(notification?.text === 'コピーできませんでした' && notification.tone === 'error', kind + ' copy failure notification')
        rejectCopy = false
        store.setState({ server: { ...server, app: { ...server.app, remote: true } } })
        await render(kind)
        check(![...document.querySelectorAll('header button')].some((button) => button.textContent?.trim() === '開く'), kind + ' open menu hidden on remote')
        passed.push(kind + ': exact path / success and failure notifications / closes / terminal independent / label fits / remote hidden')
      }
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
      else delete (navigator as any).clipboard
      store.setState({ server, toasts: [] })
      await render('view')
    }
    return passed
  },
  async scroll() {
    const longRun = { ...run, text: Array.from({ length: 80 }, (_, index) => 'Paragraph ' + index).join('\n\n') }
    store.setState({ server: { ...server, ab: [longRun] } })
    await render('view')
    const content = () => document.querySelector<HTMLDivElement>('.ab-content')!
    const atBottom = () => content().scrollHeight - content().clientHeight - content().scrollTop < 2
    check(content().clientHeight > 0 && content().scrollHeight > content().clientHeight, 'AB scroll fixture overflows')
    check(atBottom(), 'AB opens at bottom')
    content().scrollTop = 0
    store.setState({ server: { ...server, ab: [{ ...longRun, updatedAt: 2 }] } })
    await tick()
    check(content().scrollTop === 0, 'AB updates preserve reading position')
    await render('start'); await render('view')
    check(atBottom(), 'AB reopens at bottom')
    root.render(<AbView id="other" />); await tick()
    check(!document.querySelector('.ab-content'), 'AB waits for run data')
    store.setState({ server: { ...server, ab: [longRun, { ...longRun, id: 'other' }] } })
    await tick()
    check(atBottom(), 'AB delayed run opens at bottom')
    content().scrollTop = 0
    root.render(<AbView id="run" />); await tick()
    check(atBottom(), 'AB run switch opens at bottom')
    store.setState({ server })
    return 'AB scroll: open / reopen / delayed data / run switch / preserve reading position'
  },
  async run() {
    const passed: string[] = [await api.scroll()]
    for (const kind of ['start', 'view']) {
      const method = kind === 'start' ? 'ab.create' : 'ab.revise'
      await render(kind)
      const before = count(method)
      await key(); check(count(method) === before, `${kind} empty Enter`)
      await text('draft')
      await key({ shiftKey: true }); await key({ isComposing: true }); await key({ keyCode: 229 } as KeyboardEventInit)
      check(count(method) === before, `${kind} Shift/IME`)
      const matchMedia = window.matchMedia
      window.matchMedia = ((query: string) => query === '(pointer: coarse)' ? { matches: true } : matchMedia(query)) as typeof window.matchMedia
      await key(); window.matchMedia = matchMedia
      check(count(method) === before, `${kind} touch`)
      delay = 'attachment.add'; await paste(); await key()
      check(count(method) === before, `${kind} uploading guard`)
      delay = ''; release?.(); await tick()
      check(document.querySelectorAll('.attachment img').length > 0, `${kind} preview`)
      const attached = document.querySelectorAll('.attachment img').length
      fail = 'attachment.add'; await paste(); fail = ''
      check(input().value === 'draft' && document.querySelectorAll('.attachment img').length === attached, `${kind} upload failure retains previous attachments`)
      fail = method; await key()
      check(input().value === 'draft' && document.querySelector('.attachment img'), `${kind} send failure retains draft`)
      fail = ''; delay = method
      const sent = count(method)
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await tick(); check(count(method) === sent + 1, `${kind} duplicate guard`)
      delay = ''; release?.(); await tick()
      if (kind === 'view') check(!input().value && !document.querySelector('.ab-followup .attachment'), 'follow-up cleared after success')
      await render(kind); await paste(); await key()
      check(requests.filter((request) => request.type === method).at(-1).text === '', `${kind} image-only send`)
      passed.push(`${kind}: empty / Shift / IME / touch / upload / failure retention / duplicate / image-only`)
    }
    await render('view')
    check(document.querySelectorAll('.ab-question .attachment img').length === 2, 'history images restored')
    check(count('ab.approve') === 0, 'Enter never approves')
    passed.push('history image rendering / no implicit approval')
    await render('start')
    check([...document.querySelectorAll('.ab-effort')].every((button) => button.textContent?.includes('中')), 'all four unspecified efforts display medium')
    check(Object.values(requests.filter((request) => request.type === 'ab.configure').at(-1).config.efforts).every((value) => value === 'medium'), 'all four defaults saved as medium')
    for (const button of [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]) {
      button.scrollIntoView({ block: 'center' }); button.click(); await tick()
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!
      check(!menu.textContent?.includes('既定'), 'default-only menu entry removed')
      const rect = menu.getBoundingClientRect()
      check(menu.parentElement === document.body && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'menu fits viewport outside clipping parent')
      const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      check(document.activeElement === items[0], 'initial keyboard focus')
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      check(document.activeElement === items[2], 'ArrowUp wraps to final effort')
      items[2].click(); await tick()
      check(document.activeElement === button, 'focus returns to trigger')
      check(button.textContent?.includes('高'), 'menu selection displayed')
    }
    await tick()
    check(Object.values(requests.filter((request) => request.type === 'ab.configure').at(-1).config.efforts).every((value) => value === 'high'), 'all four efforts saved')
    passed.push('all four portal menus: placement / selection / persistence')
    const originalLevels = server.catalog.effortsByModel[model]
    for (const [levels, expected] of [[[ { value: 'low' } ], '低'], [[], '指定不可'], [undefined, '中']] as const) {
      if (levels === undefined) delete server.catalog.effortsByModel[model]
      else server.catalog.effortsByModel[model] = levels
      await render('start')
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]
      check(buttons.every((button) => button.textContent?.includes(expected)), `AB capability state: ${expected}`)
      check(buttons.every((button) => button.disabled === (expected === '指定不可')), `AB capability disabled: ${expected}`)
      await render('eco')
      for (const label of ['親の推論レベル', '子の推論レベル']) {
        const element = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
        check(element.selectedOptions[0]?.textContent === expected && element.disabled === (expected === '指定不可'), `eco capability state: ${expected}`)
      }
      savedModels = { leader: model, provider: 'gpt', model: 'fixture', leaderEffort: '', childEffort: '' }
    }
    server.catalog.effortsByModel[model] = originalLevels
    passed.push('AB/eco legacy defaults: nearest / no reasoning disabled / unknown medium')
    await render('eco')
    check(document.querySelector<HTMLSelectElement>('[aria-label="親の推論レベル"]')!.value === 'medium' && document.querySelector<HTMLSelectElement>('[aria-label="子の推論レベル"]')!.value === 'medium', 'eco unspecified efforts display medium')
    delay = 'execution.setModels'; await select('親の推論レベル', 'high'); await select('子の推論レベル', 'low')
    const before = count('team.create')
    const start = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '始める')!
    start.click(); start.click(); await tick()
    check(count('team.create') === before, 'eco waits for pending model saves')
    release?.(); await tick(); delay = ''; release?.(); await tick(); await tick()
    check(count('team.create') === before + 1, 'eco duplicate start')
    const choices = requests.filter((request) => request.type === 'team.create').at(-1).choices
    check(choices.gptLeader.effort === 'high' && choices.gpt.low.effort === 'low', 'eco parent/child execution values')
    await render('eco')
    check(document.querySelector<HTMLSelectElement>('[aria-label="親の推論レベル"]')!.value === 'high' && document.querySelector<HTMLSelectElement>('[aria-label="子の推論レベル"]')!.value === 'low', 'eco restored efforts')
    passed.push('eco independent effort persistence / execution payload / ordered pending saves / duplicate start')
    passed.push(...await api.openMenus())
    return passed
  },
}
Object.assign(window, { abTest: api })
await render('start')
