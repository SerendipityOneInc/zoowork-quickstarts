/**
 * Turn driver — the streaming crown (streaming-experience-contract; hardening #1). The
 * single place a Zooclaw session event becomes frames. Split per the spec:
 *
 *  - `translate(ev)` is PURE: one session event → stored frame(s). No I/O, no cross-event
 *    state. Its frame shapes are exactly what `deriveChat` (generic chat) and a vertical's
 *    domain derive both read, so there is one frame vocabulary, not three.
 *  - `driveTurn(...)` is the stateful driver: it pulls events from `@zooclaw-agents/sdk`
 *    (server-side cursor resume; session-scoped stream), translates each, pushes to an
 *    INJECTED sink (the DO injects "emit → store"; a probe injects "push → array"), and
 *    accumulates shown text so the caller can decide drain/backfill. It returns the newest
 *    resume token (plus the highest seq, the recovery bound) so the caller's window loop
 *    can resume.
 *
 * RESUME IS AN OPAQUE TOKEN (SDK 0.2.0): streamed events carry `ev.cursor` and the next
 * window passes it back as `{ cursor }` — the server replays from right after that event.
 * Tokens are minted by the server only; never derive one from a seq. The numeric `after`
 * option still exists on the SDK but selects the DEPRECATED engine-only lane, which does
 * not carry echoed user input events — this driver never passes it. A caller restored from
 * pre-token state (a stored number) resumes on a CURSORLESS stream instead, with
 * `skipThrough` dropping everything already handled, and earns its first token from the
 * first streamed event (skipped ones included).
 *
 * THE WIRE IS THE SDK'S PROBLEM, NOT OURS. Event envelopes arrive in two different shapes
 * (REST snake_case, SSE camelCase) and the payloads are nested; the SDK normalizes both and
 * exposes `assistantText` / `thinkingText` / `toolCall` / `isRunFinished`. This file only
 * decides what a frame looks like.
 *
 * TURN END IS A REAL EVENT: `run.finished` is the terminal run boundary and carries
 * `payload.status` (succeeded | failed | aborted) — the Events reference. The stream itself
 * is per-SESSION and unbounded (it does not close at turn end), so the caller still runs a
 * status poll, but that is now a BACKSTOP for a dropped window, not the primary signal.
 */
import { assistantText, isRunFinished, runOutcome, thinkingText, toolCall, type SessionEvent, type ZooclawClient } from '@zooclaw-agents/sdk'
import { normText } from '../frame-text.ts'

/** A frame's stored `data` payload (always an object in practice). */
export type FrameData = Record<string, unknown>

/** Where translated frames go. The DO assigns a durable seq and appends to the store; a
 *  probe pushes into an array. driveTurn never assigns the store seq itself. */
export interface FrameSink {
  emit(data: FrameData): void | Promise<void>
}

export interface TurnEnd {
  /** True when `run.finished` arrived — the authoritative turn boundary. */
  terminal: boolean
  /** The run's outcome: succeeded | failed | aborted. */
  status?: string
  /** Newest resume token in hand (the last `ev.cursor` seen, else the one passed in) —
   *  persist it and feed it back as `cursor` to resume the next window. The key is absent
   *  only while NO event has ever carried a token (pre-token server, or a window that saw
   *  no events on a cursorless stream); resume then falls back to skipThrough=lastSeq. */
  cursor?: string
  /** Highest durable seq observed. Seqs still ride every event — only the RESUME
   *  mechanism moved to opaque tokens — so this stays the skipThrough recovery bound and
   *  the caller's progress signal. Never pass it to the SDK as `after`. */
  lastSeq: number
  /** Set when the window died mid-stream (SSE reset, sink/D1 failure). The frames emitted
   *  before the error are ALREADY durable, so the caller must persist cursor/lastSeq/
   *  emittedText BEFORE handling this as a retryable error — retrying from the pre-window
   *  cursor would re-append everything this window already wrote (duplicate bubbles that
   *  survive refresh, since frames are the source of truth). */
  streamError?: unknown
}

export interface DriveOpts {
  /** Opaque resume token from a previous window (`ev.cursor`): the server replays from
   *  right after that event. Omit to stream the whole log from the start. */
  cursor?: string
  /** Client-side replay guard: events with 0 < seq <= skipThrough were already handled by
   *  an earlier window/turn and are dropped before translation — a replayed
   *  `run.finished` from a PREVIOUS turn must not terminate this one. Skipped events
   *  still hand back their `cursor`, which is how a caller restored from a pre-token
   *  numeric cursor (cursorless stream) earns its first token. */
  skipThrough?: number
  signal?: AbortSignal
  /** Answer text already shown (normText-accumulated) — pass a persisted ref across
   *  windows so a re-delivered final message isn't doubled after a resume. */
  emittedText?: { value: string }
}

const textFrame = (text: string): FrameData => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

/** Exact-match emitted-text ledger (space-delimited normText entries in the persisted
 *  string — normText strips ALL whitespace, so a space can never occur inside an entry).
 *  A plain substring check would false-positive on a short message that happens to be a
 *  substring of an earlier one; delimiters make the match whole-entry. */
export const alreadyEmitted = (ref: { value: string }, text: string): boolean => ref.value.includes(` ${normText(text)} `)
export const recordEmitted = (ref: { value: string }, text: string): void => {
  ref.value += ` ${normText(text)} `
}

/**
 * One session event → frames. The vocabulary is the engine's SESSION_EVENT_TYPES; the
 * payload shapes are pinned in the Events reference.
 *
 * Types that deliberately produce no user-visible frame:
 *  - `agent.item` — a durable ordering barrier (`kind: assistant_segment`) or a provider-hook
 *    LLM-request capture. Internal plumbing, never content.
 *  - `agent.lifecycle` / `run.started` — turn boundaries the UI already shows as "running".
 *  - `chat.*` — per-run Redis stream frames; they are NOT session_events and never reach
 *    this stream. The durable final text is `agent.assistant`.
 *  - `message.outbound` — proactive delivery (message tool / schedule / heartbeat), which
 *    belongs to whatever channel it targets, not to this turn's transcript.
 *  - input echoes (`user.message`, `user.interrupt`, …) — the unified stream carries the
 *    session's own inputs back; the kit already rendered the prompt from its store, so an
 *    echo is stream traffic, not new content.
 * They still ride through as `__zooclaw` debug frames so the debug pane can show the raw
 * stream; the chat derivation ignores any frame whose keys are all `__`-prefixed.
 */
export function translate(ev: SessionEvent): FrameData[] {
  switch (ev.eventType) {
    case 'agent.assistant': {
      const text = assistantText(ev)
      return text.trim() ? [textFrame(text)] : []
    }
    case 'agent.thinking': {
      const text = thinkingText(ev)
      return text.trim() ? [{ __zooclaw: 'thinking', payload: { text } }] : []
    }
    case 'agent.tool': {
      const call = toolCall(ev)
      if (!call) return []
      // A tool call is two events sharing a toolCallId: `start` carries the args (rendered
      // as the assistant's tool_use block), `end` carries the result preview (rendered as
      // the matching tool_result). `blocked` means it is waiting on an approval and has NOT
      // run — an `end` still follows, so emitting a result frame here would be a lie.
      if (call.phase === 'start') {
        return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: call.toolCallId, name: call.toolName, input: call.args ?? {} }] } }]
      }
      if (call.phase === 'end') {
        return [
          {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: call.toolCallId, content: call.resultPreview ?? '', is_error: call.isError ?? false }] },
          },
        ]
      }
      return [{ __zooclaw: 'tool_blocked', payload: { toolCallId: call.toolCallId, toolName: call.toolName } }]
    }
    case 'agent.error': {
      // The one durable event that is a failure message meant for the user; everything else
      // that goes wrong surfaces as a run.finished status instead.
      const msg = typeof ev.payload.errorMessage === 'string' ? ev.payload.errorMessage : ''
      return msg ? [{ __error: msg }] : []
    }
    default:
      return [{ __zooclaw: ev.eventType, payload: ev.payload }]
  }
}

export async function driveTurn(client: ZooclawClient, agentId: string, sessionId: string, sink: FrameSink, opts: DriveOpts = {}): Promise<TurnEnd> {
  const emitted = opts.emittedText ?? { value: '' }
  const skipThrough = opts.skipThrough ?? 0
  let lastSeq = skipThrough
  let cursor = opts.cursor
  const withCursor = (end: TurnEnd): TurnEnd => (cursor === undefined ? end : { ...end, cursor })

  const push = async (frames: FrameData[]): Promise<void> => {
    for (const f of frames) await sink.emit(f)
  }

  try {
    for await (const ev of client.streamEvents(agentId, sessionId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })) {
      if (ev.cursor) cursor = ev.cursor
      if (ev.seq > lastSeq) lastSeq = ev.seq

      // Replay guard: skip BEFORE translation (the seq > 0 test spares no-seq frames),
      // so a replayed previous-turn `run.finished` cannot terminate this turn — but only
      // after the token/seq bookkeeping above, so skipped events still advance the resume
      // state (the pre-token restore path earns its first token here).
      if (skipThrough && ev.seq > 0 && ev.seq <= skipThrough) continue

      if (ev.eventType === 'agent.assistant') {
        const text = assistantText(ev).trim()
        if (!text) continue
        // The same text can arrive twice across a resumed window (boundary replay) or as a
        // later summary segment — dedupe against what this turn already showed.
        if (alreadyEmitted(emitted, text)) continue
        await push(translate(ev))
        recordEmitted(emitted, text)
        continue
      }

      if (isRunFinished(ev)) {
        return withCursor({ terminal: true, status: runOutcome(ev) ?? 'succeeded', lastSeq })
      }

      await push(translate(ev))
    }
  } catch (e) {
    // Frames emitted before the error are durable — return the progress WITH the error
    // instead of throwing it away, so the caller can persist the cursor before retrying.
    return withCursor({ terminal: false, lastSeq, streamError: e })
  }

  // The window aborted (idle/timer) or the server closed the stream before run.finished →
  // the caller polls session status and either finalizes or resumes from the cursor.
  return withCursor({ terminal: false, lastSeq })
}
