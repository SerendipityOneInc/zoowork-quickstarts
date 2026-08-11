/**
 * FileCard — the ONE non-image attachment card. Rendered in the composer (the parent adds a
 * remove button + passes the live upload/error status) AND in the message bubble (static, no
 * status). Single source of truth for how a file attachment looks, so the two surfaces stay
 * byte-identical. Images use a thumbnail instead (Composer / ChatPanel handle that branch).
 *
 * The upload state lives ON the icon tile (a spinner replaces the glyph) — never a mask over the
 * whole card — so the filename stays readable while it uploads.
 */

const FileGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M16 13H8M16 17H8M10 9H8" />
  </svg>
)
const AlertGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </svg>
)

/** Uppercased file-type label from the name's extension, falling back to the mime subtype. */
function typeLabel(filename: string, contentType?: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot > 0 && dot < filename.length - 1) return filename.slice(dot + 1).toUpperCase()
  const sub = contentType?.split('/')[1]
  return sub ? sub.toUpperCase() : 'File'
}

export function FileCard({
  filename,
  contentType,
  status,
  reason,
}: {
  filename: string
  contentType?: string
  /** Composer only — the bubble renders the ready (status-less) card. */
  status?: 'uploading' | 'error'
  /** Why it failed (e.g. over the size cap), shown on the sub-line in the error palette. */
  reason?: string
}) {
  const sub = status === 'uploading' ? 'Uploading...' : status === 'error' ? reason ?? 'Upload failed' : typeLabel(filename, contentType)
  return (
    <span className={`file-card${status ? ` ${status}` : ''}`} title={filename}>
      <span className="file-card-icon">
        {status === 'uploading' ? (
          <span className="file-card-spinner" aria-label="Uploading" />
        ) : status === 'error' ? (
          <AlertGlyph />
        ) : (
          <FileGlyph />
        )}
      </span>
      <span className="file-card-text">
        <span className="file-card-name">{filename}</span>
        <span className="file-card-sub">{sub}</span>
      </span>
    </span>
  )
}
