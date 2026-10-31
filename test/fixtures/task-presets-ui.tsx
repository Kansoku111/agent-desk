// Isolated real React + RPC fixture: no models, credentials, or user data.
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'
const requests: any[] = []
const source = { kind: 'thread' as const, id: 'parent' }
const delegate = JSON.stringify(['openai-codex', 'fixture-implementer'])
const reviewer = JSON.stringify(['openai-codex', 'fixture-reviewer'])
let store: any, current: any, parentCalls = 0, sequence = 0
const server: any = {
  app: { myPc: 'fixture', remote: false }, openTargets: { terminal: true }, taskPresets: [],
  settings: { taskPresets: { delegate: { model: delegate, effort: 'low' }, review: { model: reviewer, effort: 'low' } }, modelVisibility: {}, projectNames: {}, usageCurrency: 'USD' },
  accounts: { chatgpt: { signedIn: true }, claude: { configured: false }, deepseek: { configured: false } },
  catalog: { providers: { 'openai-codex': 'ChatGPT' }, models: [
    { provider: 'openai-codex', id: 'fixture-implementer', value: delegate, name: '実装モデル' },
    { provider: 'openai-codex', id: 'fixture-reviewer', value: reviewer, name: 'レビューモデル' },
  ], effortsByModel: { [delegate]: [{ value: 'low' }, { value: 'medium' }], [reviewer]: [{ value: 'low' }, { value: 'medium' }] } },
}
const publish = () => store.setState({ server: { ...server, taskPresets: server.taskPresets.map((run: any) => ({ ...run })) } })
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (value: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body); requests.push(input)
    let result: any = {}
    if (input.type === 'preset.inspect') result = { workspace: 'fixture', title: '相談した機能', bases: [{ id: 'turn:implementation', label: '直前の実装リクエスト' }], checks: [] }
    if (input.type === 'preset.create') {
      parentCalls++
      current = { id: 'run-' + ++sequence, source, kind: input.kind, model: server.settings.taskPresets[input.kind].model, effort: 'low', title: '相談した機能', workspace: 'fixture', phase: 'preparing', createdAt: sequence, updatedAt: sequence, report: '', brief: '要件・範囲・完了条件・検証方法', permissionMode: 'workspace-write' }
      server.taskPresets = [...server.taskPresets, current]; result = { run: current }; publish()
    }
    if (input.type === 'preset.evidence') result = { text: input.kind === 'patch' ? '--- source.cjs\n+++ source.cjs\n+ fixed arithmetic sum' : 'verification passed', truncated: false, file: 'fixture/changes.patch' }
    if (input.type === 'preset.get') result = { run: server.taskPresets.find((run: any) => run.id === input.runId), turns: [] }
    if (input.type === 'preset.deliver') { parentCalls++; current.deliveredAt = Date.now(); current.updatedAt++; result = { sent: true }; publish() }
    if (input.type === 'settings.update') { for (const role of Object.keys(input.patch.taskPresets)) server.settings.taskPresets[role] = input.patch.taskPresets[role]; publish(); result = { settings: server.settings } }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result }) }), 10)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
store = await import('../../web/src/store')
const { OpenInMenu } = await import('../../web/src/components/ThreadView')
const { TaskPresetDialogs, TaskPresetRuns, TaskPresetModels } = await import('../../web/src/components/TaskPresets')
store.connect(); publish()
const root = createRoot(document.getElementById('root')!)
const tick = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === label)!
const check = (value: unknown, label: string) => { if (!value) throw new Error(label) }
const render = () => root.render(<div className="app" style={{ padding: 16 }}><main className="main"><header className="main-header"><h1>相談した機能</h1><OpenInMenu workspace="fixture" task={source} /></header><TaskPresetRuns source={source} /><div className="column" style={{ padding: 24 }}>方針が決まった通常タスクの会話（模擬）</div><TaskPresetDialogs /></main></div>)
const complete = async () => {
  Object.assign(current, { phase: 'completed', updatedAt: current.updatedAt + 1, worker: { kind: 'thread', id: 'worker' }, report: '変更・検証を完了しました。', result: { summary: current.kind === 'review' ? '条件分岐の不具合を修正し、回帰テストを追加しました。検証は成功しました。' : '合意した機能を実装し、テストを確認しました。', remaining: '', blocker: '' }, verification: { status: 'passed', checks: [] }, changedFiles: [{ status: 'M', path: 'src/feature.ts' }, { status: 'A', path: 'test/feature.test.ts' }], record: 'fixture/report.md', patch: 'fixture/changes.patch' })
  publish(); await tick(150)
}
const api = {
  requests,
  async run() {
    await tick()
    const labels: string[] = []
    button('開く').click(); await tick(); check(button('子に委託') && button('独立レビュー'), 'normal task menu has both actions')
    button('子に委託').click(); await tick(200)
    const textarea = document.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '日本語の追加指示\n範囲を守る')
    textarea.dispatchEvent(new Event('input', { bubbles: true })); await tick()
    button('始める').click(); await tick(200)
    check(parentCalls === 1, 'one initial parent call')
    check(requests.find((entry) => entry.type === 'preset.create').instruction === '日本語の追加指示\n範囲を守る', 'multiline instruction preserved')
    await complete(); check(parentCalls === 1 && !requests.some((entry) => entry.type === 'preset.deliver'), 'completion is UI only')
    check(button('本セッションに渡す'), 'explicit return offered')
    check(!requests.some((entry) => entry.type === 'preset.evidence'), 'evidence is lazy')
    ;[...document.querySelectorAll('summary')].find((entry) => entry.textContent === '担当による修正差分')!.click(); await tick(200)
    check(document.querySelector('.preset-evidence')?.textContent?.includes('fixed arithmetic sum'), 'remote-readable patch is shown')
    check(requests.filter((entry) => entry.type === 'preset.evidence').length === 1, 'one evidence fetch')
    labels.push('delegate: Japanese multiline instruction; completion does not wake parent; evidence loads only when opened')
    button('本セッションに渡す').click(); await tick(200)
    check(parentCalls === 2 && requests.filter((entry) => entry.type === 'preset.deliver').length === 1, 'only explicit return sends')
    check(button('送信済み')?.disabled, 'already sent is disabled'); button('閉じる').click(); await tick()
    labels.push('manual return sends once and becomes sent')
    button('開く').click(); await tick(); button('独立レビュー').click(); await tick(200)
    check(document.body.textContent?.includes('指摘箇所の修正'), 'review is explicitly review-and-fix')
    button('始める').click(); await tick(200)
    const call = requests.filter((entry) => entry.type === 'preset.create').at(-1)
    check(call.kind === 'review' && call.review.base === 'turn:implementation', 'review target explicit')
    await complete(); check(parentCalls === 3, 'review completion also one-way')
    check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow')
    labels.push('independent review: explicit target, repair contract, no auto-return, no overflow')
    return labels
  },
  async showSettings() { store.setState({ presetRun: null, presetStart: null }); root.render(<div className="settings-section" style={{ maxWidth: 600, margin: '30px auto', padding: 16 }}><TaskPresetModels /></div>); await tick() },
  async showReview() { render(); store.setState({ presetRun: current.id }); await tick(150) },
}
Object.assign(window, { taskPresetsTest: api })
render()
