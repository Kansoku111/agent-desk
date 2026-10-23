import { useEffect } from 'react'
import { Bug, FileSearch, FlaskConical, KeyRound, ListChecks, PanelLeftOpen, Sparkles, TerminalSquare, Wrench } from 'lucide-react'
import { setState, useStore } from '../store'
import { workspaceLabel } from '../util'
import { Composer } from './Composer'
import { pickDefaultModel, WorkspacePicker } from './Pickers'

const SUGGESTIONS = [
  { icon: FileSearch, text: 'このリポジトリの構成と主要な仕組みを説明して' },
  { icon: Bug, text: 'バグになりそうな箇所を探して、見つけたら修正して' },
  { icon: FlaskConical, text: 'テストを実行して、失敗しているものを直して' },
]

/** Suggestions for My PC, where no project is attached. */
const PC_SUGGESTIONS = [
  { icon: TerminalSquare, text: 'この PC の開発環境（Node、Python、Git のバージョン）を調べて' },
  { icon: Wrench, text: '毎日の作業を自動化するスクリプトを書いて' },
  { icon: ListChecks, text: '新しいアプリのアイデアを整理して、作る手順を計画して' },
]

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
  const onPc = draft.workspace === server.app.myPc
  const suggestions = onPc ? PC_SUGGESTIONS : SUGGESTIONS
  const noAccount = !accounts.chatgpt.signedIn && !accounts.claude.configured && !accounts.deepseek.configured
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
        <h1 className="home-title">
          {draft.workspace ? <>何を作りましょうか？</> : <>ワークスペースを選んで始めましょう</>}
        </h1>
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
                <p>ChatGPT のサブスクリプションでサインインするか、Claude の API キーを登録すると使い始められます。</p>
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

        {draft.workspace && (
          <div className="suggestions">
            {suggestions.map(({ icon: Icon, text }) => (
              <button
                key={text}
                type="button"
                className="suggestion"
                onClick={() => {
                  const area = document.querySelector<HTMLTextAreaElement>('.home-composer textarea')
                  if (!area) return
                  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
                  setter?.call(area, text)
                  area.dispatchEvent(new Event('input', { bubbles: true }))
                  area.focus()
                }}
              >
                <Icon size={15} />
                <span>{text}</span>
              </button>
            ))}
          </div>
        )}
        {draft.workspace && (
          <p className="home-path" title={draft.workspace}>
            {onPc ? 'My PC · プロジェクトなし · 作業フォルダ ' : `${workspaceLabel(draft.workspace, server.app.myPc, server.settings.projectNames)} · `}{draft.workspace}
          </p>
        )}
      </div>
    </div>
  )
}
