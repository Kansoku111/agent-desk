// Open via Vite: /@fs/<repository>/test/fixtures/ab-ui.html?t=fixture
// No real models, files or server state are touched. Call await abTest.run() in DevTools.
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
const { ExecutionStartDialog } = await import('../../web/src/components/ExecutionSettings')
const run = { id: 'run', workspace: 'C:\\fixture', title: 'Fixture', text: 'original', images: [image], config, phase: 'completed', revision: 1, plan: 'plan', jobs: [], messages: [{ text: 'follow-up', images: [image] }], createdAt: 1, updatedAt: 1 }
const server: any = { settings: { agentTeams: {}, modelVisibility: {} }, accounts: { chatgpt: { signedIn: true }, claude: { configured: false }, deepseek: { configured: false } }, catalog: { models: [{ value: model, id: 'fixture', provider: 'openai-codex', name: 'Fixture GPT' }], providers: { 'openai-codex': 'ChatGPT' }, fallbackEfforts: [], effortsByModel: { [model]: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] } }, ab: [run] }
store.setState({ server })
store.connect()
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 35))
let generation = 0
const render = async (kind: string) => { root.render(kind === 'start' ? <AbStartDialog key={++generation} workspace="C:\fixture" /> : kind === 'eco' ? <ExecutionStartDialog key={++generation} workspace="C:\fixture" /> : <AbView key={++generation} id="run" />); await tick() }
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
const api = {
  requests, render,
  async run() {
    const passed: string[] = []
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
    for (const button of [...document.querySelectorAll<HTMLButtonElement>('.ab-effort')]) {
      button.scrollIntoView({ block: 'center' }); button.click(); await tick()
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!
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
    await render('eco'); delay = 'execution.setModels'; await select('親の推論レベル', 'high'); await select('子の推論レベル', 'low')
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
    return passed
  },
}
Object.assign(window, { abTest: api })
await render('start')
