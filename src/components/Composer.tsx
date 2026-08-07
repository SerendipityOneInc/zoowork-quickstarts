import { useRef, useState, type DragEvent } from 'react'
import { uploadFile, type FileRef, type SentAttachment } from '../api.ts'
import { makeRenditions } from '../lib/thumbnail.ts'
import { ATTACHMENTS_ENABLED, MAX_UPLOAD_BYTES } from '../../domain/agent.ts'
import { FileCard } from './FileCard.tsx'

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

/** One attachment in the composer: an instant blob preview, uploaded eagerly; its `ref` rides on send. */
interface Attach {
  id: string
  file: File
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
  ref?: FileRef
  /** Why it failed (e.g. over the size cap) — shown as the error badge's tooltip. */
  reason?: string
}

const PaperclipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)
const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

/** Composer: one rounded shell holding a borderless auto-growing textarea, a quiet attach button, and
 *  a send button. Enter sends, Shift+Enter newlines. Image/file attachments via the 📎, paste, or
 *  drag-drop upload IMMEDIATELY (preview + loading; send is gated until uploads finish) and ride on
 *  the next turn. While ATTACHMENTS_ENABLED is false (Zooclaw has no file staging yet) every
 *  attachment ENTRY POINT is off — button hidden, paste/drag-drop inert — but the code paths stay
 *  compiled so flipping the flag re-enables them without a rewrite. The text flow is untouched. */
export function Composer({ onSend, busy }: { onSend: (text: string, atts?: SentAttachment[]) => void; busy: boolean }) {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attach[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const uploading = atts.some((a) => a.status === 'uploading')
  const canSend = !busy && !uploading && (text.trim().length > 0 || atts.some((a) => a.status === 'ready'))

  // Grow the textarea with its content up to a cap, then it scrolls.
  const grow = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  function addFiles(list: FileList | File[] | null) {
    if (!ATTACHMENTS_ENABLED) return // belt-and-braces: every entry point below is already gated
    for (const file of list ? Array.from(list) : []) {
      const id = crypto.randomUUID()
      // Reject oversize before touching the wire — the server enforces the same cap (413), so this
      // is just the fast, friendly half. The chip lands in 'error' with the reason and never uploads.
      if (file.size > MAX_UPLOAD_BYTES) {
        setAtts((prev) => [...prev, { id, file, previewUrl: URL.createObjectURL(file), status: 'error', reason: `File exceeds the ${MAX_UPLOAD_MB}MB limit` }])
        continue
      }
      setAtts((prev) => [...prev, { id, file, previewUrl: URL.createObjectURL(file), status: 'uploading' }])
      // Eager upload: build WebP renditions (images only) then upload; the ref rides on send.
      void (async () => {
        try {
          const ref = await uploadFile(file, await makeRenditions(file))
          setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'ready', ref } : a)))
        } catch (e) {
          console.error('attachment upload failed', e)
          setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error' } : a)))
        }
      })()
    }
  }
  function removeAtt(id: string) {
    setAtts((prev) => {
      const a = prev.find((x) => x.id === id)
      if (a) URL.revokeObjectURL(a.previewUrl)
      return prev.filter((x) => x.id !== id)
    })
  }
  function submit() {
    if (!canSend) return
    const ready = atts.filter((a) => a.status === 'ready' && a.ref)
    onSend(
      text.trim(),
      ready.length ? ready.map((a) => ({ id: a.ref!.id, filename: a.ref!.filename, contentType: a.file.type })) : undefined,
    )
    atts.forEach((a) => URL.revokeObjectURL(a.previewUrl))
    setText('')
    setAtts([])
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  // Drag-drop attachments onto the composer. preventDefault on dragover is REQUIRED to make this a
  // valid drop target — without it the browser navigates away to open the dropped file. Files only.
  // With attachments disabled we never preventDefault, so the composer is not a drop target at all.
  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!ATTACHMENTS_ENABLED || busy || !isFileDrag(e)) return
    e.preventDefault()
    if (!dragging) setDragging(true)
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return // ignore child-crossing
    setDragging(false)
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!ATTACHMENTS_ENABLED || busy || !isFileDrag(e)) return
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={dragging ? 'composer dragging' : 'composer'}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="composer-shell">
        {atts.length > 0 && (
          <div className="composer-attachments">
            {atts.map((a) =>
              a.file.type.startsWith('image/') ? (
                <span key={a.id} className={`attachment-card ${a.status}`} title={a.file.name}>
                  <img className="attachment-preview" src={a.previewUrl} alt={a.file.name} />
                  {a.status === 'uploading' && <span className="attachment-spinner" aria-label="Uploading" />}
                  {a.status === 'error' && <span className="attachment-badge" title={a.reason ?? 'Upload failed'}>!</span>}
                  <button className="attachment-remove" onClick={() => removeAtt(a.id)} aria-label="Remove attachment">×</button>
                </span>
              ) : (
                <span key={a.id} className="attachment-card">
                  <FileCard
                    filename={a.file.name}
                    contentType={a.file.type}
                    status={a.status === 'ready' ? undefined : a.status}
                    reason={a.reason}
                  />
                  <button className="attachment-remove" onClick={() => removeAtt(a.id)} aria-label="Remove attachment">×</button>
                </span>
              ),
            )}
          </div>
        )}
        <div className="composer-row">
          {ATTACHMENTS_ENABLED && (
            <button
              className="icon-btn attach-btn"
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              title="Add an image or file"
              aria-label="Add attachment"
            >
              <PaperclipIcon />
            </button>
          )}
          {ATTACHMENTS_ENABLED && (
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = '' // allow re-selecting the same file
              }}
            />
          )}
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            placeholder="Send a message..."
            onChange={(e) => {
              setText(e.target.value)
              grow()
            }}
            onPaste={(e) => {
              if (!ATTACHMENTS_ENABLED) return // pasted text flows through untouched
              const pasted = Array.from(e.clipboardData.files)
              if (pasted.length) {
                e.preventDefault()
                addFiles(pasted)
              }
            }}
            onKeyDown={(e) => {
              // While an IME is composing (e.g. typing pinyin), Enter commits the candidate — it
              // must NOT submit, or the composing text gets both sent AND left in the box. Bail on
              // the composition keydown; `isComposing` covers modern browsers, keyCode 229 the rest.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button className="icon-btn send-btn" type="button" onClick={submit} disabled={!canSend} title="Send" aria-label="Send">
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  )
}
