import { useState } from 'react'
import { ChevronDown, Folder, FolderPlus, Keyboard, Loader2, X } from 'lucide-react'
import { act, navigate, request, setState, useRemote } from '../store'
import { basename } from '../util'
import { Modal } from './Modal'
import { Dropdown, MenuItem } from './Popover'

export function openProjectDialog() {
  setState({ projectDialog: true })
}

// A stable function: Modal re-focuses itself whenever onClose changes.
function closeProjectDialog() {
  setState({ projectDialog: false })
}

/** Codex-style "create project": a name plus the folder the project works in. */
export function ProjectDialog() {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  // A phone cannot use the PC's folder dialog, so it types the path.
  const remote = useRemote()
  const [typing, setTyping] = useState(remote)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = (path: string) => {
    setFolder(path)
    setTyping(false)
    setTyped('')
    setError(null)
    if (!name.trim()) setName(basename(path))
  }

  const pick = async () => {
    const result = await act<{ path: string | null }>('folder.pick')
    if (result?.path) choose(result.path)
  }

  const create = async () => {
    if (!folder) return
    setBusy(true)
    setError(null)
    try {
      const result = await request<{ path: string }>('project.create', { name: name.trim(), path: folder })
      closeProjectDialog()
      setState((state) => ({ draft: { ...state.draft, workspace: result.path } }))
      navigate({ view: 'home' })
      setTimeout(() => document.querySelector<HTMLTextAreaElement>('.home-composer textarea')?.focus(), 30)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <Modal title="プロジェクトを作成" onClose={closeProjectDialog} width={500} className="project-dialog">
      <form
        className="modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <label className="project-name">
          <Folder size={15} />
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="プロジェクト名"
            aria-label="プロジェクト名"
            maxLength={80}
          />
        </label>

        <h3 className="project-section">ソースフォルダー</h3>
        <div className="project-source">
          {folder
            ? (
              <div className="project-folder">
                <Folder size={15} />
                <div>
                  <span>{basename(folder)}</span>
                  <code title={folder}>{folder}</code>
                </div>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label="フォルダーを外す"
                  onClick={() => {
                    setFolder(null)
                    setTyping(remote)
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )
            : typing
              ? (
                <div className="project-path">
                  <input
                    autoFocus
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        if (typed.trim()) choose(typed.trim().replace(/^"(.*)"$/, '$1'))
                      }
                    }}
                    placeholder="C:\path\to\project"
                    aria-label="フォルダーのパス"
                  />
                  <button type="button" className="button small" disabled={!typed.trim()} onClick={() => choose(typed.trim().replace(/^"(.*)"$/, '$1'))}>決定</button>
                  {!remote && <button type="button" className="button ghost small" onClick={() => setTyping(false)}>戻る</button>}
                </div>
              )
              : (
                <div className="project-empty">
                  <Dropdown
                    placement="bottom"
                    width={240}
                    trigger={({ toggle, open }) => (
                      <button type="button" className={`project-source-menu ${open ? 'active' : ''}`} onClick={toggle}>
                        <strong>このコンピューター</strong>のフォルダーを追加 <ChevronDown size={13} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuItem
                          icon={<FolderPlus size={14} />}
                          label="フォルダーを選択…"
                          onSelect={() => {
                            close()
                            void pick()
                          }}
                        />
                        <MenuItem
                          icon={<Keyboard size={14} />}
                          label="パスを入力…"
                          onSelect={() => {
                            close()
                            setTyping(true)
                          }}
                        />
                      </>
                    )}
                  </Dropdown>
                  <button type="button" className="button small" onClick={() => void pick()}>
                    <FolderPlus size={14} /> 追加
                  </button>
                </div>
              )}
        </div>
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={closeProjectDialog}>キャンセル</button>
          <button type="submit" className="button primary" disabled={!folder || busy}>
            {busy && <Loader2 size={14} className="spin" />} プロジェクトを作成
          </button>
        </div>
      </form>
    </Modal>
  )
}
