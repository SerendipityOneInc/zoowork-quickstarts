/**
 * The right-hand panel's shared vocabulary, factored out so the four tabs look like one
 * surface instead of four.
 *
 * `Section` carries the panel's editorial rule: every block names the SDK methods behind it.
 * The kit is a teaching probe for the SDK — a reader should be able to go from "this switch"
 * to "that call" without leaving the pane, so the method line is part of the section header,
 * not a footnote someone can forget to add.
 */
import type { ReactNode } from 'react'
import { useState } from 'react'

export function Section({
  title,
  sdk,
  caption,
  children,
}: {
  title: string
  /** The SDK method(s) this block exercises, e.g. `listAgents() · getAgent()`. Omit only for
   *  blocks that call nothing (a limitations list). */
  sdk?: string
  caption?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="cfg-section">
      <h3 className="cfg-title">{title}</h3>
      {sdk && <div className="cfg-sdk mono">{sdk}</div>}
      {caption && <p className="cfg-caption muted">{caption}</p>}
      {children}
    </section>
  )
}

/** One knob: what it is, its current effective value, where it is set, where it lands. */
export function Knob({
  name,
  value,
  where,
  lands,
  mono,
  onEdit,
}: {
  name: string
  value: string
  where: string
  lands: string
  mono?: boolean
  /** Present → render a jump button instead of duplicating the editor here. */
  onEdit?: () => void
}) {
  return (
    <div className="cfg-row">
      <div className="cfg-row-head">
        <span className="cfg-name">{name}</span>
        <span className={`cfg-value${mono ? ' mono' : ''}`}>{value}</span>
        {onEdit && (
          <button className="ghost cfg-edit" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      <div className="cfg-meta muted">
        <span>set in {where}</span>
        <span className="cfg-lands mono">{lands}</span>
      </div>
    </div>
  )
}

/** A copyable id (monospace). Falls back to a plain, still-selectable value when the
 *  clipboard is unavailable (a non-secure origin blocks navigator.clipboard). */
export function IdRow({ label, value, empty }: { label: string; value: string | null; empty: string }) {
  return (
    <div className="cfg-id">
      <span className="cfg-name">{label}</span>
      {value ? <CopyId value={value} /> : <span className="cfg-value cfg-empty">{empty}</span>}
    </div>
  )
}

/** The click-to-copy id button on its own — raw ids ARE the debugging affordance here, since
 *  there is no public ZooClaw console to link a session or agent to. */
export function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="cfg-copy mono"
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          },
          () => {
            /* clipboard blocked — the id stays on screen and selectable */
          },
        )
      }}
    >
      {value}
      <span className="cfg-copy-hint">{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

/** An agent's `status.desired_state`, coloured on the only distinction that matters to a
 *  user about to send a message: can it take one right now? */
export function StatePill({ state }: { state: string | null }) {
  if (!state) return null
  return <span className={`cfg-pill ${state === 'running' ? 'on' : 'warn'}`}>{state}</span>
}

/** Scroll a settings field into view and focus it — a Knob names the knob, the editor stays
 *  the single place it is edited. */
export function jumpTo(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  // scrollIntoView ignores the OS motion preference on its own; the rest of the kit honours
  // it (see the reduced-motion block in styles.css), so opt out of the animation explicitly.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.focus({ preventScroll: true })
}
