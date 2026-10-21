import { memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { openExternal } from '../store'
import { basename, copyText } from '../util'
import { imageRefs } from '../image-refs'
import { linkTransform } from '../link-transform'
import { FileRef, IMAGE_FILE, localImageUrl, looksLikePath, useFileInfo, useFileInfos } from './FileRef'

export function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="icon-button small"
      title={label}
      aria-label={label}
      onClick={async (event) => {
        event.stopPropagation()
        try {
          await copyText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {}
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-([\w+-]+)/.exec(className ?? '')?.[1]
  const text = textOf(children).replace(/\n$/, '')
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language ?? 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

/** An image the answer shows: a web URL as is, a local path served by Agent Desk. */
function AnswerImage({ src, alt, workspace }: { src?: string; alt?: string; workspace: string | null }) {
  const remote = !src || /^(https?:|data:|\/\/)/i.test(src)
  const info = useFileInfo(remote ? null : src, workspace)
  if (remote) return src ? <img src={src} alt={alt ?? ''} /> : null
  if (!info) return <span className="image-missing">{alt || src}</span>
  return (
    <FileRef refText={src} workspace={workspace} className="answer-image">
      <img src={localImageUrl(info.file)} alt={alt ?? ''} loading="lazy" />
    </FileRef>
  )
}

/** The images an answer names by path, shown under it; ones it already shows with ![]() are left out. */
function MentionedImages({ text, workspace }: { text: string; workspace: string | null }) {
  const refs = useMemo(() => imageRefs(text), [text])
  const infos = useFileInfos([...refs.mentioned, ...refs.shown], workspace)
  const shownFiles = new Set(infos.slice(refs.mentioned.length).map((info) => info?.file.toLowerCase()))
  const seen = new Set<string>()
  const images = refs.mentioned.flatMap((ref, index) => {
    const info = infos[index]
    if (!info || info.directory || !IMAGE_FILE.test(info.file)) return []
    const key = info.file.toLowerCase()
    if (shownFiles.has(key) || seen.has(key)) return []
    seen.add(key)
    return [{ ref, file: info.file }]
  })
  if (!images.length) return null
  return (
    <div className="mentioned-images">
      {images.map(({ ref, file }) => (
        <FileRef key={file} refText={ref} workspace={workspace} className="answer-image">
          <img src={localImageUrl(file)} alt={basename(file)} loading="lazy" />
        </FileRef>
      ))}
    </div>
  )
}

/**
 * @param workspace - the task's folder; relative paths in the text resolve
 *   against it, and files that exist become clickable. Given one, images the
 *   text names by path are also shown under it.
 */
export const Markdown = memo(function Markdown({ text, workspace = null }: { text: string; workspace?: string | null }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={linkTransform}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const content = String(textOf(children))
            const inline = !className && !content.includes('\n')
            if (!inline) return <CodeBlock className={className}>{children}</CodeBlock>
            const code = <code className="inline-code">{children}</code>
            return looksLikePath(content) ? <FileRef refText={content} workspace={workspace}>{code}</FileRef> : code
          },
          a: ({ href, children }) => {
            if (href && !/^(https?:|mailto:|#|\/\/)/i.test(href)) {
              return <FileRef refText={href} workspace={workspace}><span className="file-link">{children}</span></FileRef>
            }
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault()
                  if (href && /^https?:/i.test(href)) openExternal(href)
                }}
              >
                {children}
              </a>
            )
          },
          img: ({ src, alt }) => <AnswerImage src={typeof src === 'string' ? src : undefined} alt={alt} workspace={workspace} />,
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {workspace && <MentionedImages text={text} workspace={workspace} />}
    </div>
  )
})
