// Open via Vite: /@fs/<repository>/test/fixtures/ab-ui.html?t=fixture
// No real models, files or server state are touched. In DevTools: await abTest.run(), await abTest.openMenus(), or await abTest.remoteRestart() for the confirmed remote RPC.
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const requests: any[] = []
let fail = '', delay = '', release: (() => void) | undefined
const model = '["openai-codex","fixture"]'
const config = { a: model, b: model, leader: model, implementer: model, efforts: { a: '', b: '', leader: '', implementer: '' }, lean: true, delegate: false, review: false }
let savedAbConfig: any = config
let savedModels = { leader: model, provider: 'gpt', model: 'fixture', leaderEffort: '', childEffort: '', toolMode: 'native' }
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
      if (input.type === 'ab.config') result = { config: savedAbConfig }
      if (input.type === 'ab.create') result = { run }
      if (input.type === 'team.childTurns' || input.type === 'thread.get') result = { turns: [] }
      if (input.type === 'subagents.list') result = { subagents: [] }
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
const select = async (field: string, value: string) => {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')].find((button) => button.getAttribute('aria-label')?.startsWith(`${field}の推論レベル:`))
  check(trigger, `workflow effort trigger: ${field}`)
  check(!trigger!.disabled, `workflow effort trigger enabled: ${field}`)
  trigger!.click(); await tick()
  const menu = [...document.querySelectorAll<HTMLElement>('[role="menu"]')].find((entry) => entry.parentElement === document.body)
  check(menu, `workflow effort portal menu: ${field}`)
  const labels: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大', '': '指定なし' }
  const item = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.querySelector('.menu-label')?.textContent?.trim() === (labels[value] ?? value))
  check(item, `workflow effort menu item: ${field}=${value}`)
  item!.click(); await tick()
}
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
  async stopErrors() {
    const jobs = ['a', 'b'].map((role) => ({ id: role, role, model, status: 'stopping', report: '', stopError: 'fixture: cannot confirm exit' }))
    const update = async () => {
      store.setState({ server: { ...server, ab: [{ ...run, phase: 'stopped', jobs }] } })
      await tick()
    }
    await update(); await render('view')
    const warning = () => document.querySelector<HTMLElement>('.ab-stop-errors')
    check(warning()?.textContent?.includes('相談 A（Fixture GPT）：停止を確認できません'), 'stop failure identifies A outside details')
    check(warning()?.textContent?.includes('相談 B（Fixture GPT）：停止を確認できません'), 'stop failure identifies B outside details')
    check(!warning()?.closest('details') && document.querySelectorAll('details[open]').length === 0, 'stop warnings visible with reports closed')
    check(warning()!.getBoundingClientRect().width <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth, 'stop warnings fit viewport')
    check(document.querySelector<HTMLButtonElement>('[aria-label="ABを停止"]')?.disabled === false, 'stop remains available')
    check(!document.body.textContent?.includes('この段階を再試行'), 'retry not offered while stopping')
    document.querySelector<HTMLDetailsElement>('details')!.open = true; await tick()
    check(document.querySelector('details[open]')?.textContent?.includes('fixture: cannot confirm exit'), 'stop details retained')
    jobs[0].status = 'stopped'; jobs[0].stopError = ''; await update()
    check(!warning()?.textContent?.includes('相談 A') && warning()?.textContent?.includes('相談 B'), 'only confirmed peer warning clears')
    jobs[1].status = 'stopped'; jobs[1].stopError = ''; await update()
    check(!warning(), 'all warnings clear after confirmation')
    check(!document.querySelector('[aria-label="ABを停止"]'), 'stop button clears when idle')
    store.setState({ server }); await render('view')
    check(!warning(), 'normal history has no stop warning')
    return ['stop errors: closed reports / multiple peers / independent recovery / viewport fit']
  },
  async openMenus() {
    const restartsBefore = count('app.restart')
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
      check(count('workspace.open') === opensAfterTerminal && count('app.restart') === restartsBefore && count('restart') === 0, 'AB restart does not run anything yet')
      store.setState({ restartConfirm: false })
      store.setState({ server: { ...server, app: { ...server.app, remote: true } } })
      await render('view')
      const remoteMenu = await openMenu()
      check([...remoteMenu.menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent).join('/') === label + '/ビルドして再起動', 'AB remote menu hides PC terminal only')
      remoteMenu.trigger.click(); await tick()
      await choose('ビルドして再起動')
      check(store.getState().restartConfirm === true && count('app.restart') === restartsBefore, 'AB remote restart asks for confirmation without RPC')
      store.setState({ restartConfirm: false })
      store.setState({ server })
      await render('view')
      check([...document.querySelectorAll('.ab-header button')].some((button) => button.textContent?.trim() === '開く'), 'AB open menu shown on local')
      passed.push('AB open menu: terminal target / restart confirmation only / remote restart without PC terminal')
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
        const { menu } = await openMenu()
        check([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent).join('/') === label + '/ビルドして再起動', kind + ' remote menu keeps copy and restart only')
        ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'ビルドして再起動')!.click(); await tick()
        check(store.getState().restartConfirm === true && count('app.restart') === restartsBefore, kind + ' remote restart only opens confirmation')
        store.setState({ restartConfirm: false })
        passed.push(kind + ': exact path / success and failure notifications / closes / terminal independent / label fits / remote restart')
      }
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
      else delete (navigator as any).clipboard
      store.setState({ server, toasts: [] })
      await render('view')
    }
    return passed
  },
  async remoteRestart() {
    const { App } = await import('../../web/src/App')
    const before = count('app.restart')
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((entry) => entry.textContent === text)!
    store.setState({ server: { ...server, app: { ...server.app, remote: true } }, connection: 'open', route: { view: 'thread', id: thread.id }, sidebarOpen: false, toasts: [] })
    try {
      root.render(<App />); await tick()
      const { trigger, menu } = await openMenu()
      for (const element of [trigger, menu]) {
        const rect = element.getBoundingClientRect()
        check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'remote thread trigger and menu fit viewport')
      }
      trigger.click(); await tick()
      await choose('ビルドして再起動')
      const dialog = document.querySelector('[role="dialog"]')
      check(dialog?.textContent?.includes('実行中のタスクは停止します。'), 'remote restart warns that running tasks stop')
      check(count('app.restart') === before, 'opening confirmation sends no restart RPC')
      button('キャンセル').click(); await tick()
      check(!document.querySelector('[role="dialog"]') && count('app.restart') === before, 'cancel does not restart')
      await choose('ビルドして再起動')
      button('再起動').click(); await tick()
      check(count('app.restart') === before + 1 && !store.getState().restartConfirm, 'confirm sends exactly one restart RPC and closes')
      fail = 'app.restart'
      await choose('ビルドして再起動')
      button('再起動').click(); await tick()
      check(count('app.restart') === before + 2 && store.getState().toasts.some((entry) => entry.tone === 'error' && entry.text.includes('fixture failure')), 'remote restart failure is shown')
      return ['remote restart: warning / cancel without RPC / confirm once / failure notification']
    } finally {
      fail = ''
      store.setState({ server, restartConfirm: false, toasts: [] })
      await render('view')
    }
  },
  async reports() {
    const job = (id: string, role: string, status = 'completed', report = 'fixture report') => ({ id, role, model, status, report })
    const oldDirect = { ...job('old-direct', 'direct'), handle: { kind: 'thread', id: 'old-direct-turns' } }
    const leader = job('leader', 'leader')
    const direct = { ...job('direct', 'direct', 'running', ''), handle: { kind: 'claude', id: 'direct-turns' } }
    let jobs = [job('a', 'a'), job('b', 'b'), oldDirect, leader]
    const update = async () => { store.setState({ server: { ...server, ab: [{ ...run, jobs }] } }); await tick() }
    const report = (label: string, index = 0) => [...document.querySelectorAll<HTMLDetailsElement>('.ab-report')].filter((entry) => entry.querySelector('summary span')?.textContent === label)[index]
    const toggle = async (entry: HTMLDetailsElement) => { entry.querySelector('summary')!.click(); await tick() }
    const loaded = (id: string) => requests.some((request) => (request.type === 'team.childTurns' && request.taskId === id) || (request.type === 'thread.get' && request.threadId === id))
    try {
      await update(); await render('view')
      check(!report('相談 A').open && !report('相談 B').open, 'consultations remain closed by default')
      check(report('リーダー実装').open && loaded('old-direct-turns'), 'previous direct implementation opens and loads turns even when not latest')
      check(report('判断・報告').open, 'latest leader report still opens')
      await toggle(report('判断・報告')); await update()
      check(!report('判断・報告').open, 'other reports also stay closed after updates')
      await toggle(report('判断・報告'))
      check(report('判断・報告').open, 'other reports can also be reopened')
      jobs = [...jobs, direct]; await update()
      check(report('リーダー実装', 1).open && loaded('direct-turns'), 'running direct implementation opens before its report exists')
      await toggle(report('リーダー実装', 1))
      check(!report('リーダー実装', 1).open, 'direct implementation can be closed')
      jobs = jobs.map((entry) => entry.id === 'direct' ? { ...direct, status: 'completed', report: 'finished' } : entry); await update()
      check(!report('リーダー実装', 1).open, 'a completed report does not override a manual close')
      await toggle(report('リーダー実装', 1))
      check(report('リーダー実装', 1).open, 'direct implementation can be reopened')
      await update()
      check(report('リーダー実装', 1).open, 'reopened direct implementation stays open on updates')
      await toggle(report('リーダー実装', 1))
      await render('start'); await render('view')
      check(report('リーダー実装').open && report('リーダー実装', 1).open, 'direct implementation reports reopen when returning to AB')
      check(!report('判断・報告').open, 'previous non-direct report is closed when revisiting')
      const nextLeader = job('next-leader', 'leader', 'running', '')
      jobs = [...jobs, nextLeader]; await update()
      check(!report('判断・報告', 1).open, 'new non-direct report remains closed until it is latest')
      jobs = jobs.map((entry) => entry.id === 'next-leader' ? { ...nextLeader, status: 'completed', report: 'new report' } : entry); await update()
      check(report('判断・報告', 1).open, 'new latest non-direct report still opens when its report arrives')
      return 'AB reports: running / history / manual close and reopen / return to AB / latest report / turn loading'
    } finally {
      store.setState({ server }); await render('view')
    }
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
    const passed: string[] = [await api.scroll(), await api.reports()]
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
      const ecoEfforts = [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]
      check(ecoEfforts.length === 2 && ecoEfforts.every((button) => button.textContent?.includes(expected)), `eco capability state: ${expected}`)
      check(ecoEfforts.every((button) => button.disabled === (expected === '指定不可')), `eco capability disabled: ${expected}`)
      savedModels = { leader: model, provider: 'gpt', model: 'fixture', leaderEffort: '', childEffort: '', toolMode: 'native' }
    }
    server.catalog.effortsByModel[model] = originalLevels
    passed.push('AB/eco legacy defaults: nearest / no reasoning disabled / unknown medium')

    // A configured empty capability list makes saved explicit values invalid.
    server.catalog.effortsByModel[model] = []
    const originalAbConfig = savedAbConfig
    savedAbConfig = { ...config, efforts: { a: 'high', b: 'high', leader: 'high', implementer: 'high' } }
    await render('start')
    await text('AB no-reasoning fixture')
    const abStart = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '2社に相談')!
    const abCreatesBefore = count('ab.create')
    check(abStart.disabled, 'AB blocks saved effort unavailable on known no-reasoning model')
    abStart.click(); await tick()
    check(count('ab.create') === abCreatesBefore, 'blocked AB start sends no create RPC')
    await select('相談 A', '')
    await select('相談 B', '')
    await select('判断・報告リーダー', '')
    check(Object.values(savedAbConfig.efforts as Record<string, string>).every((value) => value === 'high'), 'ab.configure mock does not persist the fixture config')
    const clearedAbStart = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '2社に相談')!
    check(!clearedAbStart.disabled, 'AB permits start after explicit no-effort choices')
    clearedAbStart.click(); await tick(); await tick()
    const abCreate = requests.filter((request) => request.type === 'ab.create').at(-1)
    check(count('ab.create') === abCreatesBefore + 1 && ['a', 'b', 'leader'].every((key) => abCreate.config.efforts[key] === ''), 'AB sends cleared no-effort choices')
    savedAbConfig = originalAbConfig

    const originalSavedModels = savedModels
    savedModels = { leader: model, provider: 'gpt', model: 'fixture', leaderEffort: 'high', childEffort: 'high', toolMode: 'native' }
    const ecoSetsOnOpen = count('execution.setModels')
    await render('eco')
    const ecoUnsupported = [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]
    const ecoStart = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '始める')!
    check(ecoUnsupported.length === 2 && ecoUnsupported.every((button) => button.getAttribute('aria-label')?.includes('非対応') && !button.disabled), 'eco shows unsupported saved efforts with a clearable control')
    check(ecoStart.disabled && count('execution.setModels') === ecoSetsOnOpen, 'eco blocks start without rewriting saved values on open')
    const teamsBeforeClear = count('team.create')
    ecoStart.click(); await tick()
    check(count('team.create') === teamsBeforeClear, 'blocked eco start sends no team.create RPC')
    await select('親', '')
    await select('子', '')
    const clearedEcoStart = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '始める')!
    check(!clearedEcoStart.disabled, 'eco permits start after explicit no-effort choices')
    clearedEcoStart.click(); await tick(); await tick()
    const teamCreate = requests.filter((request) => request.type === 'team.create').at(-1)
    check(count('team.create') === teamsBeforeClear + 1 && teamCreate.choices.gptLeader.effort === null && teamCreate.choices.gpt.low.effort === null, 'eco sends cleared effort values')
    passed.push('AB/eco known no-effort: block stale values / clear and start')
    savedModels = originalSavedModels
    server.catalog.effortsByModel[model] = originalLevels

    await render('eco')
    const ecoDefaults = [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]
    check(ecoDefaults.length === 2 && ecoDefaults.every((button) => button.textContent?.includes('中')), 'eco unspecified efforts display medium')
    delay = 'execution.setModels'; await select('親', 'high'); await select('子', 'low')
    const before = count('team.create')
    const start = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '始める')!
    start.click(); start.click(); await tick()
    check(count('team.create') === before, 'eco waits for pending model saves')
    release?.(); await tick(); delay = ''; release?.(); await tick(); await tick()
    check(count('team.create') === before + 1, 'eco duplicate start')
    const choices = requests.filter((request) => request.type === 'team.create').at(-1).choices
    check(choices.gptLeader.effort === 'high' && choices.gpt.low.effort === 'low', 'eco parent/child execution values')
    await render('eco')
    const restoredEcoEfforts = [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]
    check(restoredEcoEfforts.length === 2 && restoredEcoEfforts[0].textContent?.includes('高') && restoredEcoEfforts[1].textContent?.includes('低'), 'eco restored efforts')
    passed.push('eco independent effort persistence / execution payload / ordered pending saves / duplicate start')
    passed.push(...await api.stopErrors())
    passed.push(...await api.openMenus())
    passed.push(...await api.remoteRestart())
    return passed
  },
}
Object.assign(window, { abTest: api })
await render('start')
