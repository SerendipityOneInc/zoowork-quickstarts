/**
 * Did a turn's chat answer actually land — and render — in storage? The UI reads
 * frames from the store (GET /content) and only renders assistant *text* frames.
 * A turn can finalize with its answer missing entirely (never persisted); this pure
 * helper detects that so the content route can self-heal from the Zooclaw session
 * transcript (streaming-experience-contract R3, case 2). Assistant text shape mirrors
 * the turn driver's emitted text frame:
 *   { type:'assistant', message:{ content:[{ type:'text', text }] } }
 *
 * The former case-1 helpers (relay `result`-channel text stored but unrendered) were
 * There is no result channel, so an unclassified
 * event lands as a `__zooclaw` passthrough with no reliable "this is the final answer"
 * signal, so there is nothing safe to backfill from locally. See the R3 row in
 * the streaming notes in README.md.
 */
import type { Frame } from './store.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
/** Whitespace-stripped, for order/format-insensitive containment dedup. */
export const normText = (s: string): string => s.replace(/\s+/g, '')

/** The text of an assistant text frame (non-empty), else null. */
export function assistantFrameText(data: unknown): string | null {
  if (!isObj(data) || data.type !== 'assistant') return null
  const content = isObj(data.message) ? (data.message as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return null
  const parts = content
    .filter((c): c is { type: string; text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .filter((t) => t.trim() !== '')
  return parts.length ? parts.join('') : null
}

export function isAssistantTextFrame(data: unknown): boolean {
  return assistantFrameText(data) !== null
}

/** True if any frame is a non-empty assistant text frame. */
export function framesHaveAssistantText(frames: Frame[]): boolean {
  return frames.some((f) => isAssistantTextFrame(f.data))
}

/** A self-heal attempt marker (appended by recoverPrompt when an upstream recovery
 *  attempt failed). The content route stops re-attempting after a couple of these —
 *  without the cap, every page load of a conversation containing an unhealable turn
 *  would re-issue an upstream transcript read forever. */
export function isHealAttemptFrame(data: unknown): boolean {
  return isObj(data) && data.__heal_attempted === true
}

/** How many failed heal attempts this prompt has recorded. */
export function healAttemptCount(frames: Frame[]): number {
  return frames.filter((f) => isHealAttemptFrame(f.data)).length
}
