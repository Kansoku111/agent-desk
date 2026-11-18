import { useEffect } from 'react'
import { KeyRound, PanelLeftOpen, Sparkles } from 'lucide-react'
import { setState, useStore } from '../store'
import { Composer } from './Composer'
import { pickDefaultModel, WorkspacePicker } from './Pickers'

export function Home() {
  const server = useStore((state) => state.server)
  const draft = useStore((state) => state.draft)
  const sidebarOpen = useStore((state) => state.sidebarOpen)

  // Choose a usable model once accounts and the catalog are known.
  useEffect(() => {
    if (!server) return
    const model = pickDefaultModel(server, draft.model)
    if (model !== draft.model) setState((state) => ({ draft: { ...state.draft, model } }))
  }, [server, draft.model])

  if (!server) return null
  const { accounts } = server
  const noAccount = !accounts.chatgpt.signedIn && !accounts.claude.configured && !accounts.deepseek.configured
    && !accounts.opencodeGo?.configured && !accounts.commandCode?.configured
    && !accounts.localLlm?.configured

  return (
    <div className="home">
      {!sidebarOpen && (
        <header className="main-header plain">
          <button type="button" className="icon-button" aria-label="サイドバーを開く" onClick={() => setState({ sidebarOpen: true })}>
            <PanelLeftOpen size={16} />
          </button>
        </header>
      )}
      <div className="home-center">
        {!draft.workspace && <h1 className="home-title">ワークスペースを選んで始めましょう</h1>}
        <div className="home-workspace">
          <WorkspacePicker
            value={draft.workspace}
            onChange={(workspace) => setState((state) => ({ draft: { ...state.draft, workspace } }))}
          />
        </div>

        {noAccount && (
          <div className="onboarding">
            <div className="onboarding-text">
              <Sparkles size={16} />
              <div>
                <strong>モデルを接続してください</strong>
                <p>ChatGPT にサインインするか、使うサービスの API キーを登録してください。</p>
              </div>
            </div>
            <button type="button" className="button primary" onClick={() => setState({ settingsOpen: 'accounts' })}>
              <KeyRound size={14} /> 接続する
            </button>
          </div>
        )}

        <div className="home-composer">
          <Composer autoFocus />
        </div>
      </div>
    </div>
  )
}
