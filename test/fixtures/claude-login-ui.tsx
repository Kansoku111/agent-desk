// Isolated UI fixture: no Claude process, provider, or application data is used.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/styles.css'
import { setState } from '../../web/src/store'
import { TerminalChat } from '../../web/src/components/TerminalChat'

const terminal: any = { id: 'fixture', workspace: 'C:\\fixture', state: 'running', activity: 'idle' }
const turns: any[] = [{
  id: 'turn', startedAt: 1, endedAt: 1001, status: 'done', stopReason: null, error: null,
  user: { text: 'こんにちは', images: [] },
  items: [{ type: 'agent', id: 'error', text: 'Login expired · Please run /login', claudeLoginRequired: true }],
}]
setState({ server: { app: { remote: false }, teams: [], settings: { usageCurrency: 'USD' } } as any })

function Fixture() {
  const [screen, setScreen] = useState(false)
  return <div className="thread-view terminal-view" style={{ height: '100vh' }}>
    {screen ? <div role="status">ターミナル画面（テスト）</div> : <TerminalChat terminal={terminal} turns={turns} omitted={0} loaded error={null}
      onShowScreen={() => setScreen(true)} onRestart={() => {}} />}
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
