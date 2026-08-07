import { useState } from 'react'
import type { PromptContent } from '../api.ts'

/**
 * The default right-hand pane: a raw inspector that lays out every turn's prompt and the
 * raw stream-json frames the backend stored. This is the kit's "expose every API return"
 * view — invaluable for seeing exactly what the Zooclaw session delivered, including the
 * `__zooclaw` typed-event passthroughs (thinking / unclassified events) that chat hides.
 * There is no public console for a Zooclaw session, so the `__zooclaw_session` marker
 * frame shows the raw session id (monospace, copyable) instead of a link. Replace via
 * domain/view.tsx.
 */
export function DebugPanel({ prompts }: { prompts: PromptContent[] }) {
  if (!prompts.length) {
    return (
      <div className="bench">
        <div className="bench-empty">
          <div className="bench-empty-mark">{'{ }'}</div>
          <p className="muted">Nothing yet. Send a message and every raw frame shows up here.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="bench debug">
      {prompts.map((p, i) => (
        <div key={p.id} className="debug-turn">
          <div className="debug-turn-head">
            turn {i + 1} · <span className="mono">{p.id.slice(0, 8)}</span> ·{' '}
            <span className={`debug-status s-${p.status ?? 'running'}`}>{p.status ?? 'running'}</span> ·{' '}
            <span className="muted">{p.frames.length} frames</span>
          </div>
          <div className="debug-prompt"><span className="muted">prompt</span> {p.prompt}</div>
          <div className="debug-frames">
            {p.frames.length === 0
              ? <div className="muted">(no frames)</div>
              : p.frames.map((f) => <FrameRow key={f.seq} seq={f.seq} data={f.data} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function FrameRow({ seq, data }: { seq: number; data: unknown }) {
  const [open, setOpen] = useState(false)
  // The session marker gets its id shown inline (selectable/copyable) — there is no
  // public Zooclaw console to link to, so the raw id IS the debugging affordance.
  const sessionId =
    data && typeof data === 'object' && typeof (data as Record<string, unknown>).__zooclaw_session === 'string'
      ? ((data as Record<string, unknown>).__zooclaw_session as string)
      : null
  return (
    <div className="debug-frame">
      <button className="debug-frame-head" onClick={() => setOpen((o) => !o)}>
        <span className="debug-seq">#{seq}</span>
        <span className="debug-kind">{frameLabel(data)}</span>
        {sessionId && <span className="mono">{sessionId}</span>}
        <span className="debug-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && <pre className="debug-json">{JSON.stringify(data, null, 2)}</pre>}
    </div>
  )
}

/** Exported for the frame-vocabulary test in src/chat.test.ts (chat hides what this labels). */
export function frameLabel(data: unknown): string {
  if (!data || typeof data !== 'object') return typeof data
  const d = data as Record<string, unknown>
  if (typeof d.__zooclaw_session === 'string') return 'zooclaw_session'
  if (typeof d.__error === 'string') return 'error'
  if (d.__ask && typeof d.__ask === 'object') return 'ask_user_question'
  if (typeof d.__zooclaw === 'string') return String(d.__zooclaw)
  if (d.type === 'assistant') {
    const content = (d.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_use')) return 'assistant · tool_use'
    return 'assistant · text'
  }
  if (d.type === 'user') return 'user · tool_result'
  return String(d.type ?? 'frame')
}
