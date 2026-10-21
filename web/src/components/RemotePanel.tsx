// Settings → スマホ: remote access over Tailscale. The PC turns it on and
// shows the link as a QR code; a phone only sees that it is connected.
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { act, openExternal, useStore } from '../store'
import type { RemoteAccessState } from '../types'
import { CopyButton } from './Markdown'
import { ConfirmDialog } from './Modal'

const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'

type PcState = Exclude<RemoteAccessState, { viewer: true }>

function Setup({ state }: { state: PcState }) {
  const [checking, setChecking] = useState(false)
  const recheck = async () => {
    setChecking(true)
    await act('remote.recheck')
    setChecking(false)
  }
  const message = state.phase === 'stopped'
    ? 'Tailscale が停止しているか、ログインしていません。Tailscale を起動してログインしてください。'
    : state.phase === 'error'
      ? `スマホ用の待ち受けを開始できませんでした: ${state.error}`
      : 'この PC で Tailscale が見つかりません。'
  return (
    <div className="remote-setup">
      <p className="notice notice-warning"><AlertTriangle size={14} />{message}</p>
      {state.phase === 'no-tailscale' && (
        <ol className="remote-steps">
          <li>この PC に Tailscale をインストールして、ログインします。</li>
          <li>スマホにも Tailscale のアプリを入れて、同じアカウントでログインします。</li>
          <li>下の「もう一度確認」を押します。</li>
        </ol>
      )}
      <div className="account-actions">
        <button type="button" className="button" disabled={checking} onClick={() => void recheck()}>
          {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} もう一度確認
        </button>
        {state.phase === 'no-tailscale' && (
          <button type="button" className="button ghost" onClick={() => openExternal(TAILSCALE_DOWNLOAD)}>
            <ExternalLink size={14} /> Tailscale をダウンロード
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Why a phone may not get through: it is not on the tailnet (or its Tailscale
 * is off), or Windows Firewall drops the connection. Hidden once a phone is in.
 */
function Checks({ state }: { state: PcState }) {
  const [checking, setChecking] = useState(false)
  const [allowing, setAllowing] = useState(false)
  if (state.clients > 0) return null
  const recheck = async () => {
    setChecking(true)
    await act('remote.recheck')
    setChecking(false)
  }
  const allow = async () => {
    setAllowing(true)
    await act('remote.allowFirewall')
    setAllowing(false)
  }
  const online = state.peers?.filter((peer) => peer.online) ?? []
  const account = state.login ? `この PC と同じアカウント（${state.login}）` : 'この PC と同じアカウント'
  return (
    <div className="remote-checks">
      <h4>接続の確認</h4>
      {state.peers && (
        state.peers.length === 0
          ? (
            <p className="notice notice-warning">
              <AlertTriangle size={14} />
              <span>Tailscale にはこの PC しかつながっていません。スマホの Tailscale アプリで{account}にログインして、接続をオンにしてください。</span>
            </p>
          )
          : online.length === 0
            ? (
              <p className="notice notice-warning">
                <AlertTriangle size={14} />
                <span>
                  ほかの端末（{state.peers.map((peer) => peer.name).join('、')}）の Tailscale がオフラインです。
                  スマホで Tailscale アプリを開いて、接続をオンにしてください。
                </span>
              </p>
            )
            : (
              <p className="notice notice-ok">
                <CheckCircle2 size={14} />
                <span>Tailscale でつながっている端末: {online.map((peer) => peer.name).join('、')}</span>
              </p>
            )
      )}
      {(state.firewall === 'blocked' || state.firewall === 'denied') && (
        <div className="notice notice-warning remote-firewall">
          <AlertTriangle size={14} />
          <div>
            <p>
              {state.firewall === 'denied'
                ? 'Windows のファイアウォールに Node.js をブロックするルールがあり、スマホからの接続が届きません。'
                : 'Windows のファイアウォールが、スマホからの接続を止めています。'}
            </p>
            <button type="button" className="button" disabled={allowing} onClick={() => void allow()}>
              {allowing ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />} ファイアウォールで許可する
            </button>
            <p className="fine-print">
              管理者の確認が出たら「はい」を選んでください。許可するのは、Tailscale からポート {state.port} への接続だけです。
              {state.firewall === 'denied' && ' この接続をブロックしているルールは無効にします。'}
            </p>
          </div>
        </div>
      )}
      {state.firewall === 'allowed' && (
        <p className="notice notice-ok"><CheckCircle2 size={14} /><span>Windows のファイアウォール: 許可されています</span></p>
      )}
      <button type="button" className="button ghost remote-recheck" disabled={checking} onClick={() => void recheck()}>
        {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} もう一度確認
      </button>
    </div>
  )
}

function Link({ state }: { state: PcState }) {
  const [confirming, setConfirming] = useState(false)
  if (!state.url) return null
  return (
    <div className="remote-link">
      {state.qrSvg && (
        // The server renders the QR code (server/remote.js) from its own link.
        <div className="remote-qr" role="img" aria-label="スマホ用リンクの QR コード" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />
      )}
      <div className="remote-link-text">
        <p>スマホのカメラでこの QR コードを読み取ると、Agent Desk が開きます。</p>
        <div className="remote-url">
          <code>{state.url}</code>
          <CopyButton text={state.url} label="リンクをコピー" />
        </div>
        <p className="muted">
          <Smartphone size={13} /> 接続中のスマホ: {state.clients} 台
        </p>
        <button type="button" className="link-button" onClick={() => setConfirming(true)}>
          新しいリンクを作る
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="新しいリンクを作りますか？"
          body="今のリンクとホーム画面のアイコンは使えなくなり、接続中のスマホは切断されます。新しい QR コードを読み取り直してください。"
          confirmLabel="新しいリンクを作る"
          danger
          onConfirm={() => void act('remote.rotate')}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

export function RemotePanel() {
  const state = useStore((current) => current.server?.remoteAccess)
  const [busy, setBusy] = useState(false)
  const pc = Boolean(state && !state.viewer && state.enabled)
  // Opening the tab asks Tailscale again: a phone may have joined since.
  useEffect(() => {
    if (pc) void act('remote.recheck')
  }, [pc])
  if (!state) return null

  if (state.viewer) {
    return (
      <div className="settings-section">
        <p className="notice"><CheckCircle2 size={14} />このスマホは Tailscale 経由で PC の Agent Desk に接続しています。</p>
        <p className="fine-print">
          スマホからの接続の設定（オン・オフ、新しいリンク）は PC で変更します。
          フォルダーの選択ダイアログ、エクスプローラーやターミナルで開く操作、ChatGPT のサインインも PC で行ってください。
        </p>
      </div>
    )
  }

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    await act('remote.set', { enabled })
    setBusy(false)
  }
  return (
    <div className="settings-section">
      <div className="setting">
        <div>
          <h3>スマホから使う（Tailscale）</h3>
          <p className="muted">
            同じ Tailscale ネットワークにつないだスマホのブラウザから、タスクの確認、メッセージの送信、承認ができます。
            家の Wi-Fi やインターネットには公開しません。
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={state.enabled} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />
          <span />
        </label>
      </div>

      {state.enabled && (
        state.phase === 'listening'
          ? <><Link state={state} /><Checks state={state} /></>
          : busy || state.phase === 'off'
            ? <p className="muted remote-checking"><Loader2 size={14} className="spin" /> Tailscale を確認しています…</p>
            : <Setup state={state} />
      )}

      <ul className="fine-print remote-notes">
        <li>使うときは、PC で Agent Desk が起動している必要があります。オンの間はウィンドウを閉じても、Agent Desk はバックグラウンドで動き続けます。</li>
        <li>スマホでも Tailscale アプリの接続をオンにしておく必要があります。</li>
        <li>リンクを知っていれば、この PC でエージェントを操作できます。他人に教えないでください。漏れたときは「新しいリンクを作る」で古いリンクを無効にできます。</li>
        <li>スマホのブラウザで「ホーム画面に追加」すると、アプリのように開けます。</li>
      </ul>
    </div>
  )
}
