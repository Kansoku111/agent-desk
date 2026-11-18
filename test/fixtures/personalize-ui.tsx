// Mocked settings RPC only: no real settings or model calls.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'
import type { CustomInstructionItem } from '../../web/src/types'

let items: CustomInstructionItem[] = [
  { id: 'git', title: 'Git管理', body: '変更を確認してからコミットしてください。', enabled: true, targets: { dsh: true, claude: true } },
  { id: 'ui', title: 'UI設計', body: '説明を増やしすぎないでください。', enabled: true, targets: { dsh: true, claude: false } },
  { id: 'writing', title: '回答の書き方', body: '結論から簡潔に書いてください。', enabled: false, targets: { dsh: false, claude: true } },
]
let failure: string | null = null
class Socket {
  readyState = 1
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const { id, type, patch } = JSON.parse(body)
    if (type !== 'settings.update') return
    const error = failure ?? (JSON.stringify(patch.customInstructionItemsBase) !== JSON.stringify(items) ? '別の画面で変更されました' : null)
    failure = null
    if (!error) publish(patch.customInstructionItems)
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ok: !error, error, result: { settings: { customInstructionItems: items } } }) }))
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { PersonalizeSettings } = await import('../../web/src/components/settings/PersonalizeSettings')
function publish(next: CustomInstructionItem[]) {
  items = structuredClone(next)
  store.setState({ server: { settings: { customInstructionItems: items } }, connection: 'open' })
}
publish(items)
store.connect()
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 620, margin: '20px auto', padding: 12 }}><PersonalizeSettings /></main>)
Object.assign(window, { personalizeFixture: { items: () => structuredClone(items), publish, failNext: () => { failure = '模擬の保存エラー' } } })
