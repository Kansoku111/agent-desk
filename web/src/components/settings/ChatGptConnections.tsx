import { Loader2, LogOut } from 'lucide-react'
import { act, useRemote, useStore } from '../../store'
import { ChatGptLimits } from '../ChatGptUsage'

/** Official SIWC and Codex have distinct authentication and usage boundaries. */
export function ChatGptConnections() {
  const server = useStore(state => state.server)
  const remote = useRemote()
  if (!server) return null
  const official = server.accounts.chatgpt
  const login = server.login
  const codex = server.accounts.codex
  const codexLogin = server.codexLogin ?? { phase: 'idle' as const }
  const busy = ['starting', 'browser', 'device'].includes(login.phase)
  const codexBusy = ['starting', 'browser', 'device'].includes(codexLogin.phase)
  return (
    <>
      <section className="account-card">
        <div className="account-head">
          <div>
            <h3>GPT チャットと Web 検索（公式）</h3>
            <p className="muted">Agent Desk として Sign in with ChatGPT に接続し、公式 Responses API を使います。</p>
          </div>
          {official.signedIn && <span className="badge success">接続済み</span>}
        </div>
        {official.needsOfficialLogin && (
          <p className="form-warning">
            公式の接続へ移行しました。もう一度サインインしてください。以前の資格情報はチャット・検索には使いません。
          </p>
        )}
        {official.signedIn && (
          <div className="account-row">
            <span>{official.email ?? 'サインイン済み'}</span>
            <button type="button" className="button" disabled={busy || remote}
              onClick={() => void act('chatgpt.logout')}>
              <LogOut size={14} /> サインアウト
            </button>
          </div>
        )}
        {official.signedIn && !official.planEnabled && (
          <p className="form-warning">ChatGPT プランの使用が許可されていません。再接続して許可を確認してください。</p>
        )}
        {(!official.signedIn || !official.planEnabled) && !busy && (
          <button type="button" className="button primary" disabled={remote}
            onClick={() => void act('chatgpt.login')}>
            Continue with ChatGPT
          </button>
        )}
        {busy && (
          <div>
            <p className="login-status">
              <Loader2 size={14} className="spin" /> PC のブラウザで Agent Desk の登録とプラン使用を承認してください。
            </p>
            <button type="button" className="button ghost" disabled={remote}
              onClick={() => void act('chatgpt.cancel')}>キャンセル</button>
          </div>
        )}
        {login.phase === 'error' && <p className="form-error">{login.message}</p>}
        {remote && <p className="fine-print">接続操作は PC の Agent Desk で行ってください。</p>}
        <p className="fine-print">
          資格情報はこの PC に保存され、チャットと検索の入力は OpenAI へ送信されます。
          プラン利用は OpenAI の利用条件に従います。GPT の高速モードはこの公式経路では利用できません。
          画像生成・Codex の利用上限は下の別接続です。
        </p>
        <p className="fine-print">
          Using ChatGPT plan ·{' '}
          <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>
        </p>
      </section>
      <section className="account-card">
        <div className="account-head">
          <div>
            <h3>画像生成と利用上限（Codex）</h3>
            <p className="muted">
              OpenAI の公式 Codex app-server（同梱 0.163.0）を使います。GPT チャットとは別のサインインです。
            </p>
          </div>
          {codex?.signedIn && <span className="badge success">接続済み</span>}
        </div>
        {codex?.signedIn && (
          <div className="account-row">
            <span>{codex.email ?? 'サインイン済み'} {codex.plan && <span className="plan-badge">{codex.plan}</span>}</span>
            <button type="button" className="button" disabled={codexBusy || remote}
              onClick={() => void act('codex.logout')}><LogOut size={14} /> サインアウト</button>
          </div>
        )}
        {!codex?.signedIn && !codexBusy && (
          <div className="account-actions">
            <button type="button" className="button primary" disabled={remote}
              onClick={() => void act('codex.login', { method: 'browser' })}>Codex にサインイン</button>
            <button type="button" className="button" disabled={remote}
              onClick={() => void act('codex.login', { method: 'device' })}>デバイスコードを使う</button>
          </div>
        )}
        {codexBusy && (
          <div>
            <p className="login-status"><Loader2 size={14} className="spin" /> Codex のサインイン完了を待っています。</p>
            {codexLogin.phase === 'device' && (
              <p>
                <a href={codexLogin.verificationUri} target="_blank" rel="noreferrer">{codexLogin.verificationUri}</a>
                {' '}コード: <strong>{codexLogin.userCode}</strong>
              </p>
            )}
            <button type="button" className="button ghost" disabled={remote}
              onClick={() => void act('codex.cancel')}>キャンセル</button>
          </div>
        )}
        {codexLogin.phase === 'error' && <p className="form-error">{codexLogin.message}</p>}
        <ChatGptLimits />
        <p className="fine-print">
          画像の依頼と参照画像は OpenAI へ送信されます。Agent Desk 専用の Codex データフォルダを使い、
          普段お使いの ~/.codex は読み書きしません。Codex の上限表示は公式 SIWC のアプリ別使用枠とは異なります。
        </p>
      </section>
    </>
  )
}
