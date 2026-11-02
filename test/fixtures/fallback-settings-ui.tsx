// Isolated browser fixture: mocked RPC, no provider or model calls.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'

const gpt = JSON.stringify(['openai-codex', 'gpt-6-luna'])
const api = JSON.stringify(['anthropic', 'claude-haiku-5-5'])
let server: any = {
  app: { remote: false, platform: 'win32', myPc: 'C:/fixture' },
  settings: { usageFallbackRoutes: new URLSearchParams(location.search).has('legacy') ? null : [{ model: gpt, effort: 'low' }, { model: 'claude:haiku', effort: 'low' }], modelVisibility: {}, lastWorkspace: null },
  accounts: { chatgpt: { signedIn: true }, claude: { configured: true }, deepseek: { configured: false }, opencodeGo: { configured: false }, localLlm: { configured: false } },
  catalog: { providers: { 'openai-codex': 'GPT', anthropic: 'Claude（API）' },
    models: [{ value: gpt, provider: 'openai-codex', id: 'gpt-6-luna', name: 'Luna' }, { value: api, provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Haiku 5.5' }],
    effortsByModel: { [gpt]: [{ value: 'low', name: 'Low' }], [api]: [{ value: 'low', name: 'Low' }] }, fallbackEfforts: [{ value: 'low', name: 'Low' }] },
}
const requests: any[] = []
let confirmed = false
class Socket {
  static CLOSING = 2
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  constructor() { queueMicrotask(() => this.onopen?.()) }
  send(body: string) {
    const input = JSON.parse(body); requests.push(input)
    let result: any = {}
    if (input.type === 'team.claudeAuth') result = { descriptor: { version: 1, mode: 'subscription', authMethod: 'claude.ai', apiProvider: 'firstParty' }, confirmed, challenge: confirmed ? undefined : 'fixture-challenge' }
    if (input.type === 'fallback.confirmClaude') { confirmed = true; result = { confirmed: true } }
    if (input.type === 'settings.update') {
      server = { ...server, settings: { ...server.settings, usageFallbackRoutes: input.patch.usageFallbackRoutes } }
      store.setState({ server: structuredClone(server) })
      result = { settings: server.settings }
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: input.id, ok: true, result }) }), 0)
  }
}
Object.assign(window, { WebSocket: Socket })
sessionStorage.setItem('agent-desk-token', 'fixture')
const store = await import('../../web/src/store')
const { UsageFallbackSettings } = await import('../../web/src/components/settings/UsageFallbackSettings')
const root = createRoot(document.getElementById('root')!)
function App() { const state = store.useStore((value) => value.server); return state && <main style={{ maxWidth: 620, margin: '20px auto', padding: 12 }}><UsageFallbackSettings server={state} /></main> }
store.setState({ server: structuredClone(server), connection: 'open' })
store.connect()
root.render(<App />)
Object.assign(window, { fallbackFixture: { requests, getSettings: () => server.settings } })
