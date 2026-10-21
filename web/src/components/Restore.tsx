import { useEffect, useState } from 'react'
import { FilePen, FilePlus2, FileX2, Loader2, RotateCcw } from 'lucide-react'
import { act, toast } from '../store'
import type { RestoreAction, Turn } from '../types'
import { Modal } from './Modal'

const LIST_LIMIT = 200

interface Preview {
  files: { path: string; action: RestoreAction }[]
  later: number
}

function report(result: { files: number; error: string | null } | null, done: string) {
  if (!result) return
  if (result.error) toast(`一部のファイルを戻せませんでした。そのファイルを開いているアプリを閉じてから、もう一度試してください（${result.error.split('\n')[0]}）`, 'error')
  else toast(result.files ? `${result.files} 個のファイルを${done}` : '変更するファイルはありませんでした', 'success')
}

function RestoreDialog({ threadId, turn, onClose }: { threadId: string; turn: Turn; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void act<Preview>('checkpoint.preview', { threadId, turnId: turn.id }).then((result) => {
      if (!alive) return
      if (result) setPreview(result)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [threadId, turn.id])

  const request = turn.user.text.split('\n').find((line) => line.trim()) ?? '画像'
  const back = preview?.files.filter((file) => file.action !== 'delete') ?? []
  const removed = preview?.files.filter((file) => file.action === 'delete') ?? []
  const restore = async () => {
    setBusy(true)
    const result = await act<{ files: number; error: string | null }>('checkpoint.restore', { threadId, turnId: turn.id })
    setBusy(false)
    report(result, '戻しました')
    if (result) onClose()
  }

  return (
    <Modal title="このリクエストの前に戻す" onClose={onClose} width={520}>
      <div className="modal-body restore-body">
        <p>
          「{request.length > 60 ? `${request.slice(0, 59)}…` : request}」を送る前の状態に、ワークスペースのファイルを戻します。
          {preview && preview.later > 0 && ` このあとの ${preview.later} 件のリクエストで行った変更も戻ります。`}
        </p>
        {!preview && !failed && <p className="restore-loading"><Loader2 size={14} className="spin" /> 戻すファイルを調べています…</p>}
        {failed && <p>戻すファイルを調べられませんでした。</p>}
        {preview && preview.files.length === 0 && <p>戻す変更はありません。ファイルはすでにこの時点の状態です。</p>}
        {back.length > 0 && <FileList title={`元に戻すファイル（${back.length}）`} files={back} />}
        {removed.length > 0 && <FileList title={`削除するファイル（${removed.length}）· この時点にはなかったもの`} files={removed} />}
        {preview && preview.files.length > 0 && (
          <ul className="restore-notes">
            <li>会話の履歴はそのまま残ります。次のメッセージで、ファイルを戻したことをエージェントに伝えます。</li>
            <li>この間にあなた自身が編集した内容も戻ります。</li>
            <li>戻したあとでも「取り消す」で今の状態に戻せます。</li>
          </ul>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>キャンセル</button>
        <button type="button" className="button primary" disabled={!preview?.files.length || busy} onClick={() => void restore()}>
          {busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
          戻す
        </button>
      </div>
    </Modal>
  )
}

function FileList({ title, files }: { title: string; files: Preview['files'] }) {
  const Icon = { restore: FilePen, recreate: FilePlus2, delete: FileX2 }
  return (
    <div className="restore-group">
      <div className="restore-group-title">{title}</div>
      <ul className="restore-list">
        {files.slice(0, LIST_LIMIT).map((file) => {
          const FileIcon = Icon[file.action]
          return (
            <li key={file.path}>
              <FileIcon size={13} />
              <code title={file.path}>{file.path}</code>
              {file.action === 'recreate' && <span className="restore-tag">削除されたファイル</span>}
            </li>
          )
        })}
        {files.length > LIST_LIMIT && <li className="muted">ほか {files.length - LIST_LIMIT} 個</li>}
      </ul>
    </div>
  )
}

/**
 * Under a finished turn: "put the files back to before this request", or, once
 * done, what was restored with a way to undo it.
 */
export function RestoreControls({ threadId, turn, busy, undoable }: {
  threadId: string
  turn: Turn
  busy: boolean
  undoable: boolean
}) {
  const [open, setOpen] = useState(false)
  const [undoing, setUndoing] = useState(false)
  if (turn.restore) {
    const undo = async () => {
      setUndoing(true)
      report(await act<{ files: number; error: string | null }>('checkpoint.undo', { threadId, turnId: turn.id }), '戻す前の状態にしました')
      setUndoing(false)
    }
    return (
      <div className="restore-done">
        <RotateCcw size={13} />
        <span>このリクエストの前の状態に戻しました{turn.restore.files > 0 && `（${turn.restore.files} 個のファイル）`}</span>
        {undoable && (
          <button type="button" className="link-button" disabled={busy || undoing} onClick={() => void undo()}>取り消す</button>
        )}
      </div>
    )
  }
  if (turn.revertedBy) return turn.checkpoint?.changed ? <div className="restore-done muted">このリクエストでの変更は戻しました</div> : null
  if (!turn.checkpoint?.before || !turn.checkpoint.changed) return null
  return (
    <>
      <button
        type="button"
        className="restore-button"
        disabled={busy}
        title={busy ? '作業中は戻せません' : 'このリクエストとそれ以降のファイルの変更を取り消します'}
        onClick={() => setOpen(true)}
      >
        <RotateCcw size={13} />
        このリクエストの前に戻す
      </button>
      {open && <RestoreDialog threadId={threadId} turn={turn} onClose={() => setOpen(false)} />}
    </>
  )
}
