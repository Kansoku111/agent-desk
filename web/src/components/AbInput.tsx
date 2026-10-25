import { useRef, useState, type KeyboardEvent } from 'react'
import { Loader2, X } from 'lucide-react'
import { attachmentUrl, isTouch, uploadAttachment } from '../store'
import type { Attachment, ImageRef } from '../types'

export function useAbDraft() {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const pending = useRef(0)
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const submit = async (ready: boolean, send: () => Promise<unknown>) => {
    if (!ready || pending.current || sending.current || (!text.trim() && !images.length)) return
    sending.current = true
    setBusy(true)
    try {
      if (await send()) { setText(''); setImages([]) }
    } finally { sending.current = false; setBusy(false) }
  }
  const paste = async (files: File[]) => {
    if (sending.current) return
    pending.current += files.length
    setUploading(pending.current)
    for (const file of files) {
      try {
        const saved = await uploadAttachment(file)
        if (saved) setImages((current) => [...current, saved])
      } finally { pending.current--; setUploading(pending.current) }
    }
  }
  return { text, setText, images, setImages, uploading, busy, submit, paste, ready: Boolean(text.trim() || images.length) && !uploading && !busy }
}

export function AbImages({ images = [] }: { images?: ImageRef[] }) {
  return images.length ? <div className="attachments">{images.map((image) => <a key={image.file} href={attachmentUrl(image.file)} target="_blank" rel="noreferrer" className="attachment"><img src={attachmentUrl(image.file)} alt={image.name || '添付画像'} /></a>)}</div> : null
}

export function AbInput({ draft, label, placeholder, rows, disabled, onSubmit }: {
  draft: ReturnType<typeof useAbDraft>; label: string; placeholder: string; rows: number; disabled: boolean; onSubmit: () => void
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey && !isTouch()) { event.preventDefault(); onSubmit() }
  }
  return <div>
    {(draft.images.length > 0 || draft.uploading > 0) && <div className="attachments">
      {draft.images.map((image) => <div className="attachment" key={image.file}><img src={image.previewUrl} alt={image.name || '添付画像'} /><button type="button" className="attachment-remove" disabled={disabled} aria-label="添付を外す" onClick={() => draft.setImages((images) => images.filter((entry) => entry.file !== image.file))}><X size={12} /></button></div>)}
      {draft.uploading > 0 && <div className="attachment loading"><Loader2 size={16} className="spin" /></div>}
    </div>}
    <textarea className="ab-input" aria-label={label} placeholder={placeholder} rows={rows} maxLength={100000} value={draft.text} disabled={disabled} onChange={(event) => draft.setText(event.target.value)} onKeyDown={onKeyDown} onPaste={(event) => {
      const files = [...event.clipboardData.files].filter((file) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
      if (files.length) { event.preventDefault(); void draft.paste(files) }
    }} />
  </div>
}
