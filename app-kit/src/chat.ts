/**
 * Generic stream-json frames → chat bubbles. The domain-agnostic core of frame
 * derivation: it surfaces user prompts, assistant text, and backend errors — nothing
 * app-specific. Domain tool_results are intentionally ignored here; a vertical renders
 * those from the raw frames in its OWN derive (for a full
 * frame → domain-state machine) and never forks this core.
 *
 * Zooclaw control frames are chat-invisible by design: `{ __zooclaw_session }` (the DO's
 * session marker — there is no public console URL to link to) and `{ __zooclaw, payload }`
 * (typed-event passthroughs, e.g. thinking) derive NO bubble; the DebugPanel is where
 * they surface.
 *
 * Invariant I0 (streaming-experience-contract): this is a pure fold over frames, so the
 * live tail (frames fed incrementally) and a refresh rebuild (frames fed in one batch)
 * derive the identical view. Locked by src/chat.test.ts.
 */
import type { Attachment, PromptContent } from './api.ts'

/** A blocked ask: the agent paused this turn to ask the user. Carries the ids the answer
 *  endpoint needs. NOTE: today NOTHING produces `__ask` frames. The inbound event DOES
 *  exist — `agent.approval` with `phase: 'requested'` (the Events reference), paired with
 *  the tool call's `agent.tool` `phase: 'blocked'` — but it speaks approvals
 *  (`approvalId` + a resolution) rather than this card's `messageId`/`actionId` pair, so
 *  wiring it is a mapping decision, not a missing event. The card + answer path stay wired
 *  so translating it in server/zooclaw/turn-driver.ts lights this up with no UI change. */
export interface Ask {
  actionId: number
  messageId: string
  question: string
  options: { label: string; description?: string }[]
  /** True for a multi-select question — the card lets the user pick several then Send (a
   *  single-select submits on the first click). */
  multiSelect?: boolean
  /** Free-form UI payload from the agent (e.g. `{ type: 'form', fields: [...] }`). When it's a
   *  form the card renders inputs and submits `{ values }` instead of option indices; any other
   *  shape just rides alongside the options. */
  input?: unknown
  /** True once the turn moved on (a later assistant-text frame arrived) — render the card inert.
   *  This is the ONE field a fold mutates as frames stream (the card flips answered when the reply
   *  lands); every other bubble is prefix-stable per I0. */
  answered: boolean
}

export interface ChatBubble {
  key: string
  role: 'user' | 'assistant'
  text: string
  /** Turn-level failure (backend `__error` frame) — render in the error palette. */
  error?: boolean
  /** Images/files attached to a user turn — rendered above the text (thumbnails / chips). */
  attachments?: Attachment[]
  /** When set, the bubble renders as an ask_user_question card (options / free-text / form, per the
   *  agent's ask shape). */
  ask?: Ask
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

export function deriveChat(prompts: PromptContent[]): ChatBubble[] {
  const chat: ChatBubble[] = []
  for (const p of prompts) {
    // Only attach the key when there are attachments, so an optimistic turn (undefined) and a
    // reloaded one (server may send []) derive the identical user bubble (I0).
    chat.push({ key: `u-${p.id}`, role: 'user', text: p.prompt, ...(p.attachments?.length ? { attachments: p.attachments } : {}) })
    // Asks still awaiting an answer; the next assistant-text frame flips them inert (covers
    // reload). The live optimistic hide is the component's own concern.
    const pendingAsks: Ask[] = []
    for (const f of p.frames) {
      const data = f.data
      if (!isObj(data)) continue

      // Zooclaw control frames — chat renders NOTHING for them. `__zooclaw_session` is the DO's
      // turn marker (no public URL exists for a Zooclaw session, so there is no link bubble);
      // `__zooclaw` passthroughs (thinking / unclassified typed events) are debug-pane material.
      if (typeof data.__zooclaw_session === 'string' || typeof data.__zooclaw === 'string') continue
      // A blocked ask: the agent paused to ask. Render a question card (options / free-text /
      // form). NOTE: no backend path emits `__ask` yet (inbound HITL unwired — see the Ask
      // interface note); this branch is the ready-made consumer for when the the API
      // event lands. multiSelect/input are spread only when present so an option-only ask
      // derives the identical bubble whether built optimistically or rebuilt on reload (I0).
      if (isObj(data.__ask)) {
        const a = data.__ask as Omit<Ask, 'answered'>
        const ask: Ask = {
          actionId: a.actionId, messageId: a.messageId, question: a.question, options: a.options, answered: false,
          ...(a.multiSelect ? { multiSelect: true } : {}),
          ...(a.input !== undefined ? { input: a.input } : {}),
        }
        chat.push({ key: `q-${p.id}-${f.seq}`, role: 'assistant', text: '', ask })
        pendingAsks.push(ask)
        continue
      }
      // backend error surfaced as a chat bubble — without it a failed turn is
      // indistinguishable from a blank reply once the loading indicator clears
      if (typeof data.__error === 'string' && data.__error.trim()) {
        chat.push({ key: `e-${p.id}-${f.seq}`, role: 'assistant', text: data.__error, error: true })
        continue
      }
      // assistant text (full `assistant` frames; partial stream deltas are ignored)
      if (data.type === 'assistant' && isObj(data.message)) {
        const text = textFromContent((data.message as Record<string, unknown>).content)
        if (text.trim()) {
          chat.push({ key: `a-${p.id}-${f.seq}`, role: 'assistant', text })
          // a reply after a question(s) marks them answered → the card renders inert (no rescan)
          for (const ask of pendingAsks) ask.answered = true
          pendingAsks.length = 0
        }
      }
    }
  }
  // de-dupe consecutive identical bubbles (the full message can repeat across channels)
  const out: ChatBubble[] = []
  for (const b of chat) {
    const prev = out[out.length - 1]
    if (prev && !b.ask && !prev.ask && prev.role === b.role && prev.text === b.text && prev.error === b.error) continue
    out.push(b)
  }
  return out
}
