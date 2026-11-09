// Isolated real React + RPC fixture: no models, credentials, or user data.
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'
const requests: any[] = []
const source = { kind: 'thread' as const, id: 'parent' }
const delegate = JSON.stringify(['openai-codex', 'fixture-implementer'])
const reviewer = JSON.stringify(['openai-codex', 'fixture-reviewer'])
let store: any, current: any, parentCalls = 0, sequence = 0
const server: any = {
  app: { myPc: 'fixture', remote: false }, openTargets: { terminal: true }, taskPresets: [], threads: [{ id: 'parent', title: '相談した機能' }], terminals: [],
  settings: { taskPresets: { delegate: { model: delegate, effort: 'low' }, review: { model: reviewer, effort: 'low' }, reviewClaude: { model: 'claude:haiku', effort: 'low' } }, modelVisibility: {}, projectNames: {}, usageCurrency: 'USD' },
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
    if (input.type === 'preset.inspect') result = { workspace: 'fixture', title: '相談した機能', checks: [] }
    if (input.type === 'team.claudeAuth') result = { descriptor: { version: 1, mode: 'subscription', authMethod: 'fixture', apiProvider: '' }, challenge: null, confirmed: true }
    if (input.type === 'preset.create') {
      parentCalls++
      current = { id: 'run-' + ++sequence, source, kind: input.kind, reviewMode: input.reviewMode, model: (input.kind === 'review' ? server.settings.taskPresets.reviewSelected ?? server.settings.taskPresets.review : server.settings.taskPresets.delegate).model, effort: 'low', title: '相談した機能', workspace: 'fixture', phase: 'preparing', createdAt: sequence, updatedAt: sequence, report: '', brief: '要件・範囲・完了条件・検証方法', permissionMode: 'workspace-write' }
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
const render = () => root.render(<div className="app" style={{ padding: 16 }}><main className="main"><header className="main-header"><h1>相談した機能</h1><OpenInMenu workspace="fixture" task={source} /></header><div className="thread-body"><TaskPresetRuns source={source} onClose={() => {}} /></div><div className="column" style={{ padding: 24 }}>方針が決まった通常タスクの会話（模擬）</div><TaskPresetDialogs /></main></div>)
const complete = async () => {
  Object.assign(current, { phase: 'completed', updatedAt: current.updatedAt + 1, worker: { kind: 'thread', id: 'worker' }, report: '変更・検証を完了しました。', result: { summary: current.kind === 'review' ? '条件分岐の不具合を修正し、回帰テストを追加しました。検証は成功しました。' : '合意した機能を実装し、テストを確認しました。', remaining: '', blocker: '' }, verification: { status: 'passed', checks: [] }, changedFiles: [{ status: 'M', path: 'src/feature.ts' }, { status: 'A', path: 'test/feature.test.ts' }], record: 'fixture/report.md', patch: 'fixture/changes.patch' })
  if (current.reviewMode === 'opinion') { parentCalls++; current.deliveredAt = Date.now() }
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
    await complete(); store.setState({ presetRun: current.id }); await tick(200); check(parentCalls === 1 && !requests.some((entry) => entry.type === 'preset.deliver'), 'completion is UI only')
    check(document.querySelector('aside[aria-label="委託とレビュー"]')?.textContent?.includes('実装モデル'), 'delegate model appears in side panel')
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
    check(document.querySelectorAll('fieldset.preset-switch').length === 2, 'exactly two review selectors')
    check(document.body.textContent?.includes('Claude Code / Haiku'), 'Claude harness shows its configured model')
    check(!document.querySelector('textarea') && !document.querySelector('select'), 'no extra instruction or scope controls')
    check((document.querySelector('input[name="review-mode"][value="opinion"]') as HTMLInputElement)?.checked, 'opinion is the default')
    ;(document.querySelector('input[name="review-harness"][value="dsh"]') as HTMLInputElement).click()
    ;(document.querySelector('input[name="review-mode"][value="fix"]') as HTMLInputElement).click(); await tick()
    check((document.querySelector('input[name="review-mode"][value="fix"]') as HTMLInputElement).checked && document.body.textContent?.includes('作業フォルダーに書き込み'), 'fix switch changes permission')
    ;(document.querySelector('input[name="review-mode"][value="opinion"]') as HTMLInputElement).click(); await tick()
    check(document.body.textContent?.includes('読み取り専用'), 'opinion switch restores read-only')
    button('始める').click(); await tick(200)
    const call = requests.filter((entry) => entry.type === 'preset.create').at(-1)
    check(call.kind === 'review' && call.harness === 'dsh' && call.reviewMode === 'opinion' && !('instruction' in call), 'review uses selected harness and opinion with no typed input')
    await complete(); store.setState({ presetRun: current.id }); await tick(200); check(parentCalls === 4 && button('送信済み')?.disabled, 'opinion is automatically returned once')
    check(document.querySelector('aside[aria-label="委託とレビュー"]')?.textContent?.includes('レビューモデル'), 'review model appears in side panel')
    check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow')
    labels.push('independent review: two selectors, opinion default, automatic return, no overflow')
    return labels
  },
  async startup() {
    const uuid = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
    // Match a plain HTTP browser: getRandomValues exists, randomUUID does not.
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    server.settings.taskPresets.reviewSelected = { model: reviewer, effort: 'low' }
    const labels: string[] = []
    try {
      for (const kind of ['review', 'delegate'] as const) {
        render(); store.setState({ presetRun: null, presetStart: { source, kind } }); await tick(200)
        const before = requests.filter((entry) => entry.type === 'preset.create').length
        check(!button('始める').disabled, kind + ' is ready')
        button('始める').click(); await tick(200)
        const creates = requests.filter((entry) => entry.type === 'preset.create')
        check(creates.length === before + 1, kind + ' reaches the server without randomUUID')
        check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(creates.at(-1).requestId), 'valid request UUID')
        check(!document.querySelector('[role="dialog"]'), kind + ' start dialog closes')
        labels.push(kind + ': HTTP-compatible start request')
      }
      for (const kind of ['review', 'delegate'] as const) {
        const random = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues')
        Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: () => { throw new Error('fixture ID failure') } })
        try {
          render(); store.setState({ presetRun: null, presetStart: { source, kind } }); await tick(200)
          const before = requests.filter((entry) => entry.type === 'preset.create').length
          button('始める').click(); await tick(200)
          check(document.querySelector('[role="alert"]')?.textContent === 'fixture ID failure', kind + ' shows the preparation error')
          check(!button('始める').disabled && !button('キャンセル').disabled, kind + ' unlocks its controls')
          check(requests.filter((entry) => entry.type === 'preset.create').length === before, 'failed ID sends no request')
          ;(document.querySelector('[role="dialog"] button[aria-label="閉じる"]') as HTMLButtonElement).click(); await tick()
          check(!document.querySelector('[role="dialog"]'), kind + ' close button works after the error')
          labels.push(kind + ': ID error is visible and close button works')
        } finally {
          if (random) Object.defineProperty(crypto, 'getRandomValues', random)
          else Reflect.deleteProperty(crypto, 'getRandomValues')
        }
      }
      check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow')
      return labels
    } finally {
      if (uuid) Object.defineProperty(crypto, 'randomUUID', uuid)
      else Reflect.deleteProperty(crypto, 'randomUUID')
    }
  },
  async failures() {
    const sent = requests.filter((entry) => entry.type === 'preset.deliver').length
    const calls = parentCalls
    current = { id: 'failed-start-' + ++sequence, source, kind: 'delegate', model: delegate, effort: 'low', title: '制作の相談', workspace: 'fixture', phase: 'needs-attention', createdAt: sequence, updatedAt: sequence, report: '', error: '開始状況を確認してください', permissionMode: 'workspace-write' }
    server.taskPresets.push(current); publish(); store.setState({ presetRun: current.id }); render(); await tick(200)
    check(document.body.textContent?.includes('担当は開始していません'), 'startup failure is distinct from a worker report')
    check(!button('本セッションに渡す') && !button('送信済み'), 'startup metadata cannot be returned as a worker report')
    current = { ...current, id: 'no-report-' + ++sequence, worker: { kind: 'thread', id: 'worker-no-report' }, phase: 'stopped', createdAt: sequence, updatedAt: sequence }
    server.taskPresets.push(current); publish(); store.setState({ presetRun: current.id }); await tick(200)
    check(document.body.textContent?.includes('担当からの報告はまだありません'), 'allocated worker alone is not a report')
    check(button('同じ担当で続ける'), 'explicit continuation remains available')
    check(!button('本セッションに渡す'), 'no-report attempt cannot be returned')
    check(requests.filter((entry) => entry.type === 'preset.deliver').length === sent && parentCalls === calls, 'opening failures never prompts the parent')
    check(document.documentElement.scrollWidth <= innerWidth, 'failure copy fits the viewport')
    return ['startup error is not a worker report', 'no-report state cannot prompt the parent', 'explicit continuation remains available']
  },
  async showSettings() { store.setState({ presetRun: null, presetStart: null }); root.render(<div className="settings-section" style={{ maxWidth: 600, margin: '30px auto', padding: 16 }}><TaskPresetModels /></div>); await tick() },
  async showReview() { render(); store.setState({ presetRun: current.id }); await tick(150) },
}
Object.assign(window, { taskPresetsTest: api })
render()
