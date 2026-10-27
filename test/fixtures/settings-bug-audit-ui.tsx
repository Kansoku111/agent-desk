// Open through Vite: /@fs/<repository>/test/fixtures/settings-bug-audit-ui.html
// In DevTools: await settingsAudit.run(). The real AccountsSettings and ExecutionChecksDialog render;
// RPC and state are mocked in this page only (no server, no provider, no network).
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

type Check = { id: string; command: string; cwd: string; timeoutMs: number }
type Workspace = { id: string; name: string }

const requests: any[] = []
// The verify answer arrives after the picker has mounted, which is the order the bug needs.
let verifyDelayMs = 150
let candidates: Workspace[] = []
let savedWorkspace: string | null = null
let checks: Check[] = []
let server: any = {}

class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body)
    requests.push(input)
    const reply = (frame: Record<string, unknown>, delay = 0) => setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ...frame }) }), delay)
    if (input.type === 'account.verify') {
      const check = savedWorkspace === null && candidates.length ? { status: 'needs-workspace', workspaces: candidates } : { status: 'valid' }
      return reply({ ok: true, result: { check } }, verifyDelayMs)
    }
    if (input.type === 'account.setWorkspace') {
      savedWorkspace = input.workspaceId
      server = { ...server, accounts: { ...server.accounts, claude: { ...server.accounts.claude, workspaceId: savedWorkspace } } }
      store.setState({ server: structuredClone(server) })
      return reply({ ok: true, result: { check: null, accounts: server.accounts } })
    }
    if (input.type === 'execution.checks') return reply({ ok: true, result: { checks } })
    if (input.type === 'execution.configure') {
      // Mirrors server/execution.js: unique IDs and a command for every row.
      const ids = input.checks.map((item: Check) => item.id)
      if (new Set(ids).size !== ids.length) return reply({ ok: false, error: '検証IDは重複しない英数字・ハイフン・下線で指定してください' })
      if (input.checks.some((item: Check) => !item.command.trim())) return reply({ ok: false, error: '検証コマンドを4000文字以内で指定してください' })
      checks = structuredClone(input.checks)
      return reply({ ok: true, result: { checks } })
    }
    reply({ ok: true, result: {} })
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { AccountsSettings } = await import('../../web/src/components/settings/AccountsSettings')
const { ExecutionChecksDialog } = await import('../../web/src/components/ExecutionSettings')
const root = createRoot(document.getElementById('root')!)
const tick = (ms = 45) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const check = (value: unknown, label: string) => { if (!value) throw new Error(label) }
const buttonText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)
const typeInto = (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  check(input, label)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const useServer = (claude: Record<string, unknown>) => {
  server = {
    app: { remote: false, platform: 'win32', myPc: 'C:/fixture' },
    settings: {},
    login: { phase: 'idle' },
    accounts: { chatgpt: { signedIn: false }, codex: { signedIn: false }, claude, deepseek: { configured: false }, opencodeGo: { configured: false } },
  }
  store.setState({ server: structuredClone(server) })
}
const api = {
  requests,
  async run() {
    const labels: string[] = []

    // Scenario 1: the one workspace the key may use arrives after the picker has mounted.
    candidates = [{ id: 'wrkspc_only', name: 'Only' }]
    savedWorkspace = null
    verifyDelayMs = 150
    requests.splice(0)
    useServer({ configured: true, masked: 'sk-ant-api…fixture', workspaceId: null })
    root.render(<AccountsSettings />)
    await tick(30)
    check(document.querySelector('input[aria-label="Claude のワークスペース ID"]'), 'picker mounted before its choices')
    await tick(200)
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Claude のワークスペース"]')
    check(select?.value === 'wrkspc_only', 'the single late choice is the selected value')
    const submit = document.querySelector<HTMLButtonElement>('.workspace-field button[type=submit]')
    check(submit && !submit.disabled, 'the 設定 button is enabled')
    submit!.click()
    await tick()
    const sentWorkspace = requests.filter((request) => request.type === 'account.setWorkspace')
    check(sentWorkspace.length === 1 && sentWorkspace[0].workspaceId === 'wrkspc_only', 'account.setWorkspace sends the candidate id')
    labels.push('workspace: late single choice is selected, enabled, and sent as its id')

    // Scenario 2: delete the first verification row, add one, then save.
    checks = [
      { id: 'check-1', command: 'npm test', cwd: '.', timeoutMs: 300000 },
      { id: 'check-2', command: 'npm run lint', cwd: '.', timeoutMs: 300000 },
    ]
    requests.splice(0)
    let closed = false
    root.render(<ExecutionChecksDialog workspace="C:/fixture" onClose={() => { closed = true }} />)
    await tick()
    check(document.querySelector<HTMLInputElement>('input[aria-label="検証1のID"]')?.value === 'check-1', 'saved rows load')
    document.querySelector<HTMLButtonElement>('button[aria-label="検証1を削除"]')!.click()
    await tick(10)
    const add = buttonText('追加')
    check(add, 'add button')
    add!.click()
    await tick(10)
    check(document.querySelector<HTMLInputElement>('input[aria-label="検証2のID"]')?.value === 'check-1', 'the added row gets an ID no row uses')
    typeInto('検証2のコマンド', 'npm run build')
    const save = buttonText('保存')
    check(save && !save.disabled, 'save button')
    save!.click()
    await tick()
    const sentChecks = requests.filter((request) => request.type === 'execution.configure')
    check(sentChecks.length === 1 && sentChecks[0].checks.map((item: Check) => item.id).join(',') === 'check-2,check-1', 'the save sends the remaining row and the added row')
    check(closed, 'the server accepted the save and the dialog closed')
    root.render(<div />)
    labels.push('checks: delete, add, and save succeed with unique IDs')
    return labels
  },
}
Object.assign(window, { settingsAudit: api })
store.connect()
