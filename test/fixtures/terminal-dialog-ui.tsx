// Isolated real React/RPC fixture. No CLI, models, credentials, or application data.
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const requests: any[] = []
let revision = 1, mode = 'choice', typed = '', checked = false, fail = false, opened = 0
const dialog = () => ({
  dialogId: 'q' + revision,
  text: ['出力形式', mode === 'choice' ? 'どの形式で保存しますか？' : mode === 'multi' ? '必要なものを複数選んでください' : '希望する形式を入力してください'],
  screen: mode === 'multi' ? '必要なものを複数選んでください\n❯ [' + (checked ? 'x' : ' ') + '] GLB\n  [ ] FBX\nSpace to toggle · Enter to submit'
    : '希望する形式を入力してください\n❯ ' + typed + '\nEnter to submit · Esc to cancel',
  options: mode === 'choice' ? [
    { key: '1', label: 'GLB', detail: 'ひとつのファイルにまとめる', selected: true },
    { key: '2', label: 'FBX', detail: 'DCC ツール向け', selected: false },
    { key: '3', label: 'Type something.', detail: '', selected: false },
  ] : [],
})
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: any) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body); requests.push(input)
    let result: any = {}, error = ''
    if (input.type === 'terminal.dialog') result = { dialog: dialog() }
    else if (input.type === 'terminal.choose' || input.type === 'terminal.respond') {
      if (fail) error = 'テスト用の送信エラー'
      else if (input.dialogId !== 'q' + revision) error = 'Claude Code の画面が変わりました'
      else {
        revision++
        if (input.type === 'terminal.choose') mode = input.key === '3' ? 'input' : 'multi'
        if (input.text) typed = input.text
        if (input.key === 'space') checked = !checked
        result = { sent: true }
      }
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: !error, result, error }) }), 10)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { DialogCard } = await import('../../web/src/components/TerminalChat')
store.connect()
const root = createRoot(document.getElementById('root')!)
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label) }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text)!
const type = async (value: string) => {
  const input = document.querySelector('textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true })); await tick()
}
let generation = 0
const render = async () => {
  root.render(<div className="thread-view terminal-view" style={{ height: '100vh' }}><div style={{ flex: 1, padding: 20 }}>会話の記録（模擬）</div><DialogCard key={++generation} terminalId="fixture" onShowScreen={() => opened++} /></div>)
  await tick(80)
}
const api = {
  requests,
  async run() {
    const labels: string[] = []
    revision++; mode = 'choice'; typed = ''; checked = false; fail = false; opened = 0; requests.splice(0)
    await render()
    check(button('3自由入力（その他）'), 'free input choice translated')
    button('3自由入力（その他）').click(); await tick(400)
    check(document.querySelector('details')?.open, 'input controls open without terminal switch')
    await type('日本語の回答\n二行目')
    fail = true; button('入力を反映').click(); await tick(400)
    check(document.querySelector('textarea')?.value === '日本語の回答\n二行目', 'failed answer retained')
    check(document.querySelector('[role=alert]')?.textContent?.includes('送信エラー'), 'inline failure')
    labels.push('free input: translated choice, auto-open, Japanese multiline, failure retained')
    fail = false; button('入力を反映').click(); await tick(400)
    check(typed === '日本語の回答\n二行目', 'text reaches CLI mock intact')
    check(!requests.some((input) => input.key === 'enter'), 'paste does not auto-confirm')
    check(document.querySelector('textarea')?.value === '', 'successful draft cleared')
    button('確定・次へ').click(); await tick(400)
    check(requests.filter((input) => input.key === 'enter').length === 1, 'explicit confirmation once')
    labels.push('input is reflected separately from explicit single confirmation')
    mode = 'multi'; revision++; await render()
    button('選択切替').click(); await tick(400)
    check(checked && document.querySelector('.terminal-dialog-screen')?.textContent?.includes('[x]'), 'multi selection reflected')
    labels.push('multi-select toggles and refreshes within chat')
    await type('書きかけ')
    revision++; await tick(1200)
    check(button('入力を反映').disabled, 'stale draft disabled after next question')
    check(document.querySelector('textarea')?.value === '書きかけ', 'stale draft not lost')
    check(opened === 0, 'no terminal navigation')
    check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal page overflow')
    labels.push('question changes preserve but block stale answers; no terminal navigation or overflow')
    return labels
  },
  async show(kind = 'choice') { mode = kind; revision++; typed = ''; await render() },
}
Object.assign(window, { terminalDialogTest: api })
await render()
