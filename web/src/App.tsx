import { Suspense, useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, WifiOff } from 'lucide-react'
import { Home } from './components/Home'
import { ProjectDialog } from './components/ProjectDialog'
import { TeamStartDialog } from './components/TeamSettings'
import { ExecutionStartDialog } from './components/ExecutionSettings'
import { Sidebar } from './components/Sidebar'
import { ThreadView } from './components/ThreadView'
import { AgentView } from './components/AgentView'
import { FileMenuHost } from './components/FileRef'
import { lazyChunk } from './lazy-chunk'
import { useSidebarSwipe } from './sidebarSwipe'
import { getState, navigate, remoteHost, setState, teamChildOf, useStore } from './store'

// Only used once opened: the terminal screen (xterm) and the settings dialog stay out of the first load.
const TerminalView = lazyChunk(() => import('./components/TerminalView').then((module) => ({ default: module.TerminalView })))
const SettingsDialog = lazyChunk(() => import('./components/Settings').then((module) => ({ default: module.SettingsDialog })))

function useTheme() {
  const theme = useStore((state) => state.server?.settings.theme ?? 'dark')
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.altKey) return
      // Claude Code has its own Ctrl shortcuts (Ctrl+B runs a command in the background).
      if (event.target instanceof Element && event.target.closest('.terminal-host')) return
      const key = event.key.toLowerCase()
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        navigate({ view: 'home' })
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('.home-composer textarea')?.focus(), 30)
      } else if (key === 'b') {
        event.preventDefault()
        setState({ sidebarOpen: !getState().sidebarOpen })
      } else if (key === ',') {
        event.preventDefault()
        setState({ settingsOpen: getState().settingsOpen ? null : 'accounts' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function Toasts() {
  const toasts = useStore((state) => state.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((entry) => (
        <div key={entry.id} className={`toast toast-${entry.tone}`}>
          {entry.tone === 'error' ? <AlertTriangle size={15} /> : entry.tone === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}
          <span>{entry.text}</span>
        </div>
      ))}
    </div>
  )
}

export function App() {
  useTheme()
  useShortcuts()
  useSidebarSwipe()
  const connection = useStore((state) => state.connection)
  const ready = useStore((state) => state.server !== null)
  const route = useStore((state) => state.route)
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const settingsOpen = useStore((state) => state.settingsOpen)
  const projectDialog = useStore((state) => state.projectDialog)
  const teamStart = useStore((state) => state.teamStart)
  const executionStart = useStore((state) => state.executionStart)
  // The server restarts into the new version; the window reconnects to it.
  const updating = useStore((state) => state.server?.updates?.app?.phase === 'installing')
  const title = useStore((state) => {
    const { route } = state
    if (route.view === 'thread') return state.server?.threads.find((thread) => thread.id === route.id)?.title
    if (route.view === 'terminal') return state.server?.terminals.find((terminal) => terminal.id === route.id)?.title
    if (route.view === 'agent') return state.server && teamChildOf(state.server, route.id)?.child.title
    return null
  })

  useEffect(() => {
    document.title = title ? `${title} – Agent Desk` : 'Agent Desk'
  }, [title])

  if (connection === 'no-token' || connection === 'revoked') {
    return (
      <div className="splash">
        <div className="splash-card">
          <h1>Agent Desk</h1>
          {remoteHost
            ? (
              <p>
                {connection === 'revoked' ? 'このリンクは使えなくなりました。' : ''}
                PC の Agent Desk で「設定 → スマホ」を開き、表示される QR コードを読み取ってください。
              </p>
            )
            : connection === 'revoked'
              ? <p>Agent Desk が再起動したため、この URL は使えません。スタートメニューの Agent Desk から開き直してください。</p>
              : (
                <>
                  <p>このページは起動時に表示される URL から開いてください。</p>
                  <pre>npm start</pre>
                </>
              )}
        </div>
      </div>
    )
  }
  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-card">
          <Loader2 size={20} className="spin" />
          <p>{connection === 'closed' ? 'サーバーに再接続しています…' : remoteHost ? 'PC の Agent Desk に接続しています…' : '起動しています…'}</p>
          {connection === 'closed' && remoteHost && <p className="muted">PC が起動していて、PC とこの端末の Tailscale がオンになっているか確認してください。</p>}
        </div>
      </div>
    )
  }

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {sidebarOpen && <Sidebar />}
      {/* Narrow screens show the sidebar over the page; a tap beside it closes it. */}
      {sidebarOpen && <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setState({ sidebarOpen: false })} />}
      <main className="main">
        {updating
          ? <div className="banner"><Loader2 size={14} className="spin" /> Agent Desk を更新しています…</div>
          : connection === 'closed' && (
            <div className="banner">
              <WifiOff size={14} /> {remoteHost ? 'PC との接続が切れました。再接続しています…' : 'サーバーとの接続が切れました。再接続しています…'}
            </div>
          )}
        {route.view === 'thread' ? <ThreadView threadId={route.id} />
          : route.view === 'terminal' ? <Suspense fallback={null}><TerminalView key={route.id} terminalId={route.id} /></Suspense>
            : route.view === 'agent' ? <AgentView taskId={route.id} /> : <Home />}
      </main>
      {settingsOpen && <Suspense fallback={null}><SettingsDialog tab={settingsOpen} /></Suspense>}
      {projectDialog && <ProjectDialog />}
      {teamStart && <TeamStartDialog key={teamStart} workspace={teamStart} />}
      {executionStart && <ExecutionStartDialog key={executionStart} workspace={executionStart} />}
      <Toasts />
      <FileMenuHost />
    </div>
  )
}
