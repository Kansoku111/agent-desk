import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, FileText, FolderOpen, Keyboard, Loader2, MessageSquare, MoreHorizontal, PanelLeftOpen,
  Paperclip, Pencil, Play, Send, Square, SquareTerminal, Trash2, X,
} from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { act, isImageAttachment, isNarrow, isTouch, onHello, onTerminalData, openExternal, request, setState, toast, uploadAttachment, useRemote, useStore } from '../store'
import { getDraft, useDraft, useImeField } from '../drafts'
import type { Attachment, TerminalSummary } from '../types'
import { copyText, workspaceLabel } from '../util'
import { ConfirmDialog } from './Modal'
import { Dropdown, MenuItem } from './Popover'
import { BackToLeader, TeamPanel, TeamToggle, useLedTeam } from './TeamPanel'
import { OpenInMenu } from './ThreadView'
import { TerminalChat, useConversation } from './TerminalChat'
import { TerminalModelPicker } from './TerminalPickers'
import { Elapsed } from './TurnView'

type Size = { cols: number; rows: number }

/** `chat`: the conversation as messages (the default; easy to read and scroll); `screen`: Claude Code's own terminal screen. */
type Mode = 'chat' | 'screen'
const MODE_KEY = 'agent-desk.terminal-mode'

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'chat' || saved === 'screen') return saved
  } catch {}
  return 'chat'
}

/** Most wheel steps waiting to be sent while a swipe runs ahead of the one-per-frame pace. */
const MAX_OWED = 6

const DARK = {
  background: '#171717', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#171717', selectionBackground: 'rgba(110, 150, 255, 0.35)',
  black: '#2e2e2e', red: '#ff7b72', green: '#4ac26b', yellow: '#e3b341', blue: '#6aa0ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#d0d0d0',
  brightBlack: '#6e6e6e', brightRed: '#ffa198', brightGreen: '#7ee787', brightYellow: '#f2cc60', brightBlue: '#a5c8ff', brightMagenta: '#e2c5ff',
  brightCyan: '#87e8ef', brightWhite: '#ffffff',
}
const LIGHT = {
  background: '#fbfbfb', foreground: '#1f1f1f', cursor: '#1f1f1f', cursorAccent: '#fbfbfb', selectionBackground: 'rgba(47, 111, 235, 0.25)',
  black: '#1f1f1f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0550ae', brightMagenta: '#6639ba',
  brightCyan: '#1b7c83', brightWhite: '#8c959f',
}

function darkTheme() {
  const theme = document.documentElement.dataset.theme
  return theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Answers the terminal gives to Claude Code's queries (cursor position, device attributes, colors, version). */
const REPLY = /^\x1b(\[[?>]?[\d;]*[Rcn]|\[\?[\d;]*\$y|\][\d;]*;|P)/
const FOCUS = /^\x1b\[[IO]$/

const sendInput = (terminalId: string, data: string, reply = false) => {
  request('terminal.input', { terminalId, data, reply }).catch(() => {})
}

function statusLabel(terminal: TerminalSummary) {
  if (terminal.state === 'exited') return '終了'
  if (terminal.state === 'stopped') return '停止中'
  if (terminal.activity === 'approval') return '承認待ち'
  if (terminal.activity === 'running') return '作業中'
  // The turn is over, but agents it started go on: the app must not be closed or Claude Code started again.
  if (terminal.background > 0) return `裏で作業中（${terminal.background}）`
  return '待機中'
}

/** The task's state; while background work goes on, it opens a list of what runs and for how long. */
function StatusChip({ terminal }: { terminal: TerminalSummary }) {
  const running = terminal.state === 'running'
  const className = `header-chip terminal-status ${running ? terminal.activity : terminal.state}`
  const content = (
    <>
      {running && (terminal.activity === 'running' || terminal.background > 0) && <Loader2 size={12} className="spin" />}
      {statusLabel(terminal)}
    </>
  )
  const work = terminal.backgroundWork ?? []
  if (!running || terminal.activity !== 'idle' || !work.length) return <span className={className}>{content}</span>
  return (
    <Dropdown
      placement="bottom"
      width={320}
      className="background-work"
      trigger={({ toggle, open }) => (
        <button type="button" className={`${className} ${open ? 'active' : ''}`} aria-expanded={open} onClick={toggle}>{content}</button>
      )}
    >
      {() => (
        <ul className="background-work-list">
          {[...work].sort((a, b) => a.since - b.since).map((entry, index) => (
            <li key={index}>
              <span className="background-work-label" title={entry.label}>{entry.label}</span>
              <span className="background-work-time"><Elapsed since={entry.since} /></span>
            </li>
          ))}
        </ul>
      )}
    </Dropdown>
  )
}

function Header({ terminal, mode, onMode, onRestart }: { terminal: TerminalSummary; mode: Mode; onMode: (mode: Mode) => void; onRestart: () => void }) {
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const myPc = useStore((state) => state.server?.app.myPc)
  const names = useStore((state) => state.server?.settings.projectNames)
  const remote = useRemote()
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [title, setTitle] = useState(terminal.title)
  useEffect(() => setTitle(terminal.title), [terminal.title])
  const save = async () => {
    setRenaming(false)
    if (title.trim() && title.trim() !== terminal.title) await act('terminal.update', { terminalId: terminal.id, title: title.trim() })
  }
  const running = terminal.state === 'running'
  const team = useLedTeam(terminal.id)
  const leads = terminal.team?.role === 'leader'
  return (
    <header className="main-header">
      <div className="header-left">
        {!sidebarOpen && (
          <button type="button" className="icon-button" aria-label="サイドバーを開く" title="サイドバーを開く (Ctrl+B)" onClick={() => setState({ sidebarOpen: true })}>
            <PanelLeftOpen size={16} />
          </button>
        )}
        {terminal.team?.role === 'child' && <BackToLeader teamId={terminal.team.id} childId={terminal.team.childId} />}
        {leads
          ? <span className="cl-mark tm-mark" title="エージェントチームのリーダー（Claude Code）">TM</span>
          : <span className="cl-mark" aria-hidden="true">CL</span>}
        {renaming
          ? (
            <input
              className="title-input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void save()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Enter') void save()
                if (event.key === 'Escape') {
                  setTitle(terminal.title)
                  setRenaming(false)
                }
              }}
              aria-label="タスク名"
            />
          )
          : <h1 className="thread-heading" onDoubleClick={() => setRenaming(true)} title={terminal.title}>{terminal.title}</h1>}
        <span className="header-chip" title={terminal.workspace}><FolderOpen size={13} />{workspaceLabel(terminal.workspace, myPc, names)}</span>
        <StatusChip terminal={terminal} />
      </div>
      <div className="header-right">
        {leads && <TeamToggle team={team} />}
        <button
          type="button"
          className="icon-button"
          aria-label={mode === 'chat' ? 'ターミナル画面で見る' : '会話の表示に切り替える'}
          title={mode === 'chat' ? 'ターミナル画面で見る' : '会話の表示に切り替える'}
          onClick={() => onMode(mode === 'chat' ? 'screen' : 'chat')}
        >
          {mode === 'chat' ? <SquareTerminal size={16} /> : <MessageSquare size={16} />}
        </button>
        {!remote && <OpenInMenu workspace={terminal.workspace} />}
        <Dropdown
          placement="bottom"
          align="right"
          width={200}
          trigger={({ toggle }) => (
            <button type="button" className="icon-button" aria-label="その他の操作" onClick={toggle}><MoreHorizontal size={16} /></button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} label="名前を変更" onSelect={() => { close(); setRenaming(true) }} />
              {running
                ? (
                  <MenuItem
                    icon={<Square size={14} />}
                    label="Claude Code を終了"
                    onSelect={() => {
                      close()
                      void act('terminal.stop', { terminalId: terminal.id })
                    }}
                  />
                )
                : <MenuItem icon={<Play size={14} />} label="会話を再開" onSelect={() => { close(); onRestart() }} />}
              <MenuItem
                icon={<Trash2 size={14} />}
                label={leads ? 'チームを削除' : '削除'}
                description={leads ? 'リーダーと子のタスクをすべて削除します' : undefined}
                danger
                onSelect={() => {
                  close()
                  // Deleting a team's leader deletes its children and their reports: asked first.
                  if (leads) setRemoving(true)
                  else void act('terminal.remove', { terminalId: terminal.id })
                }}
              />
            </>
          )}
        </Dropdown>
      </div>
      {removing && (
        <ConfirmDialog title="チームを削除しますか？"
          body={<p>リーダーと子 {team?.children.length ?? 0} 人のタスクと、報告の記録を削除します。この操作は元に戻せません。実行中の作業は停止します。</p>}
          confirmLabel="チームを削除" danger
          onClose={() => setRemoving(false)} onConfirm={() => void act('terminal.remove', { terminalId: terminal.id })} />
      )}
    </header>
  )
}

/** Sends one wheel step to Claude Code (its full-screen view scrolls itself), or scrolls the terminal's own history. */
function wheel(term: Terminal, terminalId: string, up: boolean) {
  if (term.modes.mouseTrackingMode !== 'none') {
    const col = Math.ceil(term.cols / 2)
    const row = Math.ceil(term.rows / 2)
    sendInput(terminalId, `\x1b[<${up ? 64 : 65};${col};${row}M`)
  } else {
    term.scrollLines(up ? -1 : 1)
  }
}

/**
 * A field for typing (with the IME and voice input); its button sends, or stops
 * Claude Code while it works and the field is empty. The keys a phone's keyboard
 * does not have (`showKeys`) are for what the chat cannot answer.
 */
function TouchKeys({ terminalId, term, working, showKeys, onSent }: {
  terminalId: string
  term: Terminal | null
  working: boolean
  showKeys: boolean
  onSent: () => void
}) {
  const [text, setText] = useDraft(`terminal:${terminalId}`)
  const ime = useImeField()
  const file = useRef<HTMLInputElement>(null)
  const arrow = (code: string) => (term?.modes.applicationCursorKeysMode ? `\x1bO${code}` : `\x1b[${code}`)
  const keys: { label: ReactNode; title: string; data: () => string }[] = [
    { label: 'Esc', title: 'Esc', data: () => '\x1b' },
    { label: 'Tab', title: 'Tab', data: () => '\t' },
    { label: '⇧Tab', title: 'Shift+Tab（モードの切り替え）', data: () => '\x1b[Z' },
    { label: <ArrowUp size={15} />, title: '上', data: () => arrow('A') },
    { label: <ArrowDown size={15} />, title: '下', data: () => arrow('B') },
    { label: <ArrowLeft size={15} />, title: '左', data: () => arrow('D') },
    { label: <ArrowRight size={15} />, title: '右', data: () => arrow('C') },
    { label: <CornerDownLeft size={15} />, title: 'Enter', data: () => '\r' },
  ]
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  const submit = async () => {
    if (sending || uploading > 0) return
    // Read from the store: the IME's last text settles into it as the button is pressed.
    const sent = getDraft(`terminal:${terminalId}`)
    if (attachments.length) {
      // The files go in first, so their paths come before the message.
      setSending(true)
      try {
        for (const entry of attachments) {
          if (await act('terminal.insertFile', { terminalId, file: entry.file }) === null) return
        }
        // Claude Code reads each pasted image path before it takes the next input.
        await new Promise((resolve) => setTimeout(resolve, 500))
      } finally {
        setSending(false)
      }
      setAttachments([])
    }
    if (sent) {
      // A paste keeps line breaks in the message; Enter then sends it.
      if (term) {
        term.paste(sent)
        setTimeout(() => sendInput(terminalId, '\r'), 60)
      } else {
        // The screen is not open here: the server pastes the message and sends it.
        setSending(true)
        // A server from before the change answers null even when it sent the message.
        const sentOk = await request('terminal.send', { terminalId, text: sent }).then(() => true, (error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), 'error')
          return false
        })
        setSending(false)
        if (!sentOk) return
      }
      // What was typed while the message was on its way is the next one.
      if (getDraft(`terminal:${terminalId}`) === sent) setText('')
    } else {
      // The server presses Enter (and again if Claude Code did not take it); it waits for the file paths to be taken first.
      request('terminal.send', { terminalId, text: '' }).catch(() => {})
    }
    onSent()
  }
  /** Photos and other files wait here (shown above the field), then go to Claude Code as their path on the PC when sent. */
  const attach = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? [])
    if (!list.length) return
    setUploading((count) => count + list.length)
    for (const entry of list) {
      try {
        const saved = await uploadAttachment(entry)
        if (saved) setAttachments((current) => [...current, saved])
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }
  return (
    <div className="terminal-touch">
      {showKeys && (
        <div className="terminal-keys" role="toolbar" aria-label="キー">
          {keys.map((key) => (
            <button
              key={key.title}
              type="button"
              className="terminal-key"
              title={key.title}
              aria-label={key.title}
              // Keep the field focused (and the keyboard up) while tapping keys.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => sendInput(terminalId, key.data())}
            >
              {key.label}
            </button>
          ))}
        </div>
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="attachments terminal-attachments">
          {attachments.map((attachment) => (
            <div key={attachment.file} className={`attachment ${isImageAttachment(attachment) ? '' : 'file'}`} title={attachment.name}>
              {isImageAttachment(attachment)
                ? <img src={attachment.previewUrl} alt={attachment.name || '添付画像'} />
                : <><FileText size={18} /><span className="attachment-name">{attachment.name || 'ファイル'}</span></>}
              <button
                type="button"
                className="attachment-remove"
                aria-label="添付を外す"
                onClick={() => setAttachments((list) => list.filter((entry) => entry.file !== attachment.file))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {uploading > 0 && <div className="attachment loading"><Loader2 size={16} className="spin" /></div>}
        </div>
      )}
      <div
        className="terminal-input"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          void attach(event.dataTransfer.files)
        }}
      >
        <button type="button" className="terminal-attach" title="写真やファイルを添付" aria-label="写真やファイルを添付"
          onClick={() => file.current?.click()}>
          <Paperclip size={17} />
          {attachments.length > 0 && <span className="terminal-attach-count">{attachments.length}</span>}
        </button>
        <input ref={file} type="file" multiple hidden onChange={(event) => {
          void attach(event.target.files)
          event.target.value = ''
        }} />
        <textarea
          {...ime.fieldProps}
          value={text}
          rows={1}
          placeholder="Claude に送るメッセージ"
          aria-label="Claude に送るメッセージ"
          onChange={(event) => setText(event.target.value)}
          // Enter sends on a computer (Shift+Enter breaks the line); on a phone it stays a line break.
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 || isTouch()) return
            event.preventDefault()
            void submit()
          }}
          // Pasted screenshots and files wait above the field like picked ones.
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (!files.length) return
            event.preventDefault()
            void attach(files)
          }}
        />
        {working && !text && attachments.length === 0 && uploading === 0
          ? (
            <button type="button" className="terminal-send stop" title="停止" aria-label="停止"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                request('terminal.interrupt', { terminalId }).catch(() => {})
                onSent()
              }}>
              <Square size={13} fill="currentColor" />
            </button>
          )
          : (
            <button type="button" className="terminal-send" aria-label="送信" disabled={sending || uploading > 0}
              onPointerDown={(event) => {
                event.preventDefault()
                ime.confirm()
              }}
              onClick={() => void submit()}>
              <Send size={16} />
            </button>
          )}
      </div>
    </div>
  )
}

export function TerminalView({ terminalId }: { terminalId: string }) {
  const terminal = useStore((state) => state.server?.terminals.find((entry) => entry.id === terminalId))
  const host = useRef<HTMLDivElement>(null)
  const [term, setTerm] = useState<Terminal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /** The terminal's size when another window or the phone set it, and the size this screen would fit. */
  const [mismatch, setMismatch] = useState<{ fit: Size } | null>(null)
  const touch = isTouch()
  const [mode, setMode] = useState<Mode>(initialMode)
  const screen = mode === 'screen'
  const [keysOpen, setKeysOpen] = useState(false)
  const chooseMode = (next: Mode) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {}
  }
  const conversation = useConversation(terminalId, terminal, !screen)
  const team = useLedTeam(terminalId)
  const teamPanel = useStore((state) => state.teamPanel)
  const sizeRef = useRef<() => Size | null>(() => null)

  useEffect(() => {
    // The terminal screen is only set up (and kept up to date) while it is shown.
    const element = host.current
    if (!element) return
    setError(null)
    setMismatch(null)
    const xterm = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "BIZ UDGothic", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: touch ? 14 : isNarrow() ? 12 : 13,
      lineHeight: 1.1,
      scrollback: 3000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: darkTheme() ? DARK : LIGHT,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new Unicode11Addon())
    xterm.unicode.activeVersion = '11'
    xterm.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)))
    xterm.open(element)
    // A tap gives Claude Code a click; typing goes through the field below, not the phone's keyboard over the screen.
    if (touch) xterm.textarea?.setAttribute('inputmode', 'none')
    setTerm(xterm)

    let pending = 0
    const write = (data: string) => {
      pending += 1
      xterm.write(data, () => {
        pending -= 1
      })
    }
    const fitted = (): Size | null => {
      const size = fit.proposeDimensions()
      return size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null
    }
    sizeRef.current = fitted
    let shown: Size = { cols: xterm.cols, rows: xterm.rows }
    /**
     * Whether this screen sizes the terminal. Another window or the phone takes
     * over by typing; until this one types (or asks to fit), its own layout
     * changes must not take the terminal back.
     */
    let owned = true
    const same = (a: Size | null, b: Size) => a !== null && a.cols === b.cols && a.rows === b.rows
    /** Shows the terminal at the size Claude Code draws for. */
    const apply = (size: Size) => {
      shown = size
      if (size.cols !== xterm.cols || size.rows !== xterm.rows) xterm.resize(size.cols, size.rows)
      const fits = fitted()
      setMismatch(fits && !same(fits, size) ? { fit: fits } : null)
    }

    const stopData = onTerminalData(terminalId, (frame) => {
      if (frame.event === 'termReset') xterm.reset()
      else if (frame.event === 'termSize') {
        owned = same(fitted(), frame.size)
        apply(frame.size)
      } else write(frame.data)
    })
    const attach = async () => {
      const size = fitted() ?? shown
      try {
        const result = await request<{ snapshot: string; size: Size }>('terminal.attach', { terminalId, size })
        owned = true
        xterm.reset()
        apply(result.size)
        write(result.snapshot)
        setError(null)
        if (!touch) xterm.focus()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void attach()
    const stopHello = onHello(() => void attach())

    // A focus report (the window got or lost focus) is not the user typing: it must not take the terminal from the phone.
    xterm.onData((data) => sendInput(terminalId, data, FOCUS.test(data) || (pending > 0 && REPLY.test(data))))
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'c' && xterm.hasSelection()) {
        void copyText(xterm.getSelection())
        xterm.clearSelection()
        return false
      }
      // The browser pastes (text, or an image that becomes a file path below).
      if (mod && key === 'v') return false
      // Claude Code takes Alt+Enter as a new line in the message.
      if (event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
        sendInput(terminalId, '\x1b\r')
        return false
      }
      return true
    })

    // Pasted or dropped images are saved like attachments and given to Claude Code as a path.
    const giveFiles = async (files: File[]) => {
      for (const entry of files) {
        const saved = await uploadAttachment(entry)
        if (saved) await act('terminal.insertFile', { terminalId, file: saved.file })
      }
    }
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (!files.length) return
      event.preventDefault()
      event.stopPropagation()
      void giveFiles(files)
    }
    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!files.length) return
      event.preventDefault()
      void giveFiles(files)
    }
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    element.addEventListener('paste', onPaste, true)
    element.addEventListener('drop', onDrop)
    element.addEventListener('dragover', onDragOver)

    // A swipe scrolls: Claude Code's full-screen view takes wheel steps, a plain terminal its history.
    // The finger moves the view one row per row of travel and keeps it gliding (slowing down) after a flick.
    let lastY: number | null = null
    let lastX = 0
    let lastTime = 0
    let dragged = false
    let travel = 0
    let velocity = 0
    let glide = 0
    /** Wheel steps owed to Claude Code, sent one per frame so its view moves at an even pace. */
    let owed = 0
    let feed = 0
    const rowHeight = () => Math.max(8, element.clientHeight / xterm.rows)
    const pour = () => {
      feed = 0
      if (!owed) return
      wheel(xterm, terminalId, owed > 0)
      owed -= Math.sign(owed)
      // Never fall far behind a fast flick: the rest is dropped rather than replayed late.
      owed = Math.max(-MAX_OWED, Math.min(MAX_OWED, owed))
      if (owed) feed = window.requestAnimationFrame(pour)
    }
    const scrollBy = (pixels: number) => {
      travel += pixels
      const rows = Math.trunc(travel / rowHeight())
      if (!rows) return
      travel -= rows * rowHeight()
      owed += rows
      if (!feed) feed = window.requestAnimationFrame(pour)
    }
    const stopGlide = () => {
      if (glide) window.cancelAnimationFrame(glide)
      glide = 0
    }
    const onTouchStart = (event: TouchEvent) => {
      stopGlide()
      if (event.touches.length !== 1) return
      lastY = event.touches[0].clientY
      lastX = event.touches[0].clientX
      lastTime = event.timeStamp
      dragged = false
      travel = 0
      velocity = 0
    }
    const onTouchMove = (event: TouchEvent) => {
      if (lastY === null || event.touches.length !== 1) return
      const { clientX, clientY } = event.touches[0]
      const dy = clientY - lastY
      // Sideways: let the page pan a terminal wider than the screen.
      if (!dragged && Math.abs(clientX - lastX) > Math.abs(dy)) return
      event.preventDefault()
      dragged = true
      const elapsed = Math.max(1, event.timeStamp - lastTime)
      velocity = velocity * 0.4 + (dy / elapsed) * 0.6
      lastY = clientY
      lastX = clientX
      lastTime = event.timeStamp
      scrollBy(dy)
    }
    const onTouchEnd = (event: TouchEvent) => {
      lastY = null
      // Only a flick that was still moving at the release glides on.
      if (!dragged || event.timeStamp - lastTime > 80 || Math.abs(velocity) < 0.2) return
      let frame = performance.now()
      const step = (now: number) => {
        const elapsed = Math.min(now - frame, 32)
        frame = now
        scrollBy(velocity * elapsed)
        velocity *= 0.94 ** (elapsed / 16)
        glide = Math.abs(velocity) > 0.03 ? window.requestAnimationFrame(step) : 0
      }
      glide = window.requestAnimationFrame(step)
    }
    element.addEventListener('touchstart', onTouchStart, { passive: true })
    element.addEventListener('touchmove', onTouchMove, { passive: false })
    element.addEventListener('touchend', onTouchEnd)
    element.addEventListener('touchcancel', onTouchEnd)

    // Fits the screen when the window (or a phone's keyboard) changes its size.
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const size = fitted()
        if (!size) return
        if (!owned || same(size, shown)) {
          setMismatch(same(size, shown) ? null : { fit: size })
          // Kept for when this screen types next; the screen in control keeps its size.
          if (!owned) request('terminal.resize', { terminalId, size, claim: false }).catch(() => {})
          return
        }
        apply(size)
        request('terminal.resize', { terminalId, size }).catch(() => {})
      }, 80)
    })
    observer.observe(element)

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const retheme = () => {
      xterm.options.theme = darkTheme() ? DARK : LIGHT
    }
    const themeObserver = new MutationObserver(retheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media.addEventListener('change', retheme)

    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      themeObserver.disconnect()
      media.removeEventListener('change', retheme)
      element.removeEventListener('paste', onPaste, true)
      element.removeEventListener('drop', onDrop)
      element.removeEventListener('dragover', onDragOver)
      element.removeEventListener('touchstart', onTouchStart)
      element.removeEventListener('touchmove', onTouchMove)
      element.removeEventListener('touchend', onTouchEnd)
      element.removeEventListener('touchcancel', onTouchEnd)
      stopGlide()
      window.cancelAnimationFrame(feed)
      stopData()
      stopHello()
      request('terminal.detach', { terminalId }).catch(() => {})
      xterm.dispose()
      setTerm(null)
    }
  }, [terminalId, touch, attempt, screen])

  const restart = async () => {
    const size = sizeRef.current() ?? (term ? { cols: term.cols, rows: term.rows } : undefined)
    const result = await act('terminal.restart', { terminalId, size })
    if (result) term?.focus()
  }

  if (!terminal) return <div className="main-empty">タスクが見つかりません</div>
  return (
    <div className="thread-view terminal-view">
      <Header terminal={terminal} mode={mode} onMode={chooseMode} onRestart={() => void restart()} />
      <div className="thread-body">
        <div className="thread-main">
          {screen && mismatch && (
            <div className="terminal-note">
              <span>別の画面のサイズで表示しています</span>
              <button type="button" className="button" onClick={() => {
                request('terminal.resize', { terminalId, size: mismatch.fit }).catch(() => {})
              }}>この画面に合わせる</button>
            </div>
          )}
          {screen
            ? (
              <div className="terminal-frame">
                <div className="terminal-host" ref={host} />
                {error && (
                  <div className="terminal-overlay">
                    <p>{error}</p>
                    <button type="button" className="button" onClick={() => setAttempt((value) => value + 1)}>もう一度試す</button>
                  </div>
                )}
              </div>
            )
            : (
              <TerminalChat
                terminal={terminal}
                turns={conversation.turns}
                omitted={conversation.omitted}
                loaded={conversation.loaded}
                error={conversation.error}
                onShowScreen={() => chooseMode('screen')}
                onRestart={() => void restart()}
              />
            )}
          {terminal.state === 'exited' && !(screen && error) && (
            <div className="terminal-note">
              <span>Claude Code は終了しました{terminal.exitCode ? `（終了コード ${terminal.exitCode}）` : ''}</span>
              <button type="button" className="button" onClick={() => void restart()}><Play size={13} /> 会話を再開</button>
            </div>
          )}
          <div className="terminal-bar">
            <TerminalModelPicker terminal={terminal} />
            {!screen && terminal.state === 'running' && (
              <button type="button" className={`icon-button terminal-keys-toggle${keysOpen ? ' active' : ''}`} title="キーボードのキーを表示"
                aria-label="キーボードのキーを表示" aria-pressed={keysOpen} onClick={() => setKeysOpen((open) => !open)}>
                <Keyboard size={15} />
              </button>
            )}
          </div>
          {(touch || !screen) && terminal.state === 'running' && (
            <TouchKeys
              terminalId={terminalId}
              term={screen ? term : null}
              working={terminal.activity === 'running'}
              // The screen has no other way to be answered on a phone; the chat answers with buttons.
              showKeys={screen || keysOpen}
              onSent={conversation.poke}
            />
          )}
        </div>
        {team && teamPanel && team.children.length > 0 && <TeamPanel team={team} />}
      </div>
    </div>
  )
}
