import type { SessionSummary } from '../api.ts'

/** D1 timestamps are SQLite `datetime('now')` — UTC, no zone ("YYYY-MM-DD HH:MM:SS").
 *  Mark as UTC, render "MM-DD HH:mm" in the viewer's local time. */
function formatLocalTime(utc: string): string {
  const d = new Date(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return utc.slice(5, 16)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * ChatGPT-style left rail — the app's only chrome (there is no top header on desktop):
 * brand + "new chat" up top, scrollable session history (with a running spinner), and an
 * account/theme footer. Static column on desktop; a slide-in drawer on mobile (opened by the
 * mobile bar's hamburger, dismissed by the backdrop).
 */
export function Sidebar({
  brand,
  tag,
  email,
  sessions,
  currentId,
  busyIds,
  onSelect,
  onNew,
  open,
  onClose,
  theme,
  onToggleTheme,
  onTapBrand,
}: {
  brand: string
  tag?: string
  email: string
  sessions: SessionSummary[]
  currentId: string | null
  busyIds: Set<string>
  onSelect: (id: string) => void
  onNew: () => void
  open: boolean
  onClose: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  /** Tap handler on the brand logo — reveals the hidden debug pane after N taps. */
  onTapBrand?: () => void
}) {
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand" onClick={onTapBrand} style={onTapBrand ? { cursor: 'default' } : undefined}>{brand}</span>
          {tag && <span className="tag">{tag}</span>}
        </div>

        <button className="sidebar-new" onClick={onNew}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
          </svg>
          <span>New chat</span>
        </button>

        <div className="sidebar-head">Chats</div>
        <div className="sidebar-list">
          {sessions.length === 0 && <div className="sidebar-empty">No chats yet</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session${s.id === currentId ? ' active' : ''}`}
              onClick={() => onSelect(s.id)}
              title={s.title}
            >
              <span className="session-title">{s.title || 'New chat'}</span>
              <span className="session-meta">
                {(busyIds.has(s.id) || s.status === 'running') && <span className="session-spinner" aria-label="Running" />}
                {formatLocalTime(s.created_at)}
              </span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          {email && <span className="sidebar-user" title={email}>{email}</span>}
          <button
            className="theme-toggle ghost"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light' : 'Dark'}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            )}
          </button>
        </div>
      </aside>
    </>
  )
}
