# ZooClaw Managed Agents - Events and Streaming

Everything an agent does inside a session is an event. You drive a session by posting a small set
of inbound events, and you observe it by reading the outbound event log - either as a durable REST
list or as a live SSE stream. Both return the same normalized objects, so the choice is about
latency, not shape. Every call below needs an `agt_` id whose `status.desired_state` is already
`running`; see `SKILL.md` - The mandatory flow if you do not have one.

---

## The event model

The event log is per session. Every event carries a `seq` that is monotonic within that session and
never reused. `seq` is the only cursor in this API: it drives history paging, and it drives stream
resume. Persist the last one you saw next to your session id - it stays valid across process
restarts, so a worker that crashes mid-turn picks the turn back up exactly where it stopped.

The same event arrives in two different spellings depending on where you read it:

| Field | REST `GET .../events` | SSE `GET .../events/stream` |
|---|---|---|
| sequence | `seq` | `seq`, and also the SSE `id:` line |
| event type | `event_type` | `eventType` |
| run | `run_id` | `runId` |
| turn | `turn` | `turn` |
| body | `payload` | `payload` |
| timestamp | `created_at` | `createdAt` |
| extras | - | `version`, `engine`, `sessionId` |

REST is snake_case, SSE is camelCase, and **neither carries a top-level `type`**. The SDK absorbs
this once in `normalizeEvent`, so `listEvents`, `listAllEvents` and `streamEvents` all hand you the
same object and you switch on a single field:

```ts
interface SessionEvent {
  /** Durable per-session sequence. Use as the `after` cursor when resuming. */
  seq: number
  eventType: SessionEventType | string
  payload: Record<string, unknown>
  runId?: string
  turn?: number
  createdAt?: string
}
```

Details that decide how you write the consumer:

- `eventType` is `SessionEventType | string` on purpose: an unrecognized type passes through instead
  of throwing, because the API may add types within a version. Your `switch` needs a default arm
  that ignores rather than one that throws.
- `payload` is always an object, `{}` rather than `undefined` when the frame carried none. Its keys
  are camelCase on both transports - only the envelope differs. `runId`, `turn` and `createdAt` are
  omitted entirely rather than set to `undefined` when absent.
- `seq` is `-1` when a frame carried no sequence at all. On the SSE lane the `id:` line backfills it,
  which is why the SDK's parser keeps `id:`; a durable frame should never reach you with `-1`.

`normalizeEvent(raw: unknown, sseId?: string): SessionEvent` is exported, so a custom transport
(a browser `EventSource`, a proxy in another process) can reuse it rather than re-deriving both
mappings. Any other language has to write both mappings by hand - no Python package is published.
There is no top-level `type`, no `session.status_*` event, no `span.*` event, and no turn-level
stop reason: switch on `event.eventType`, and end the turn on `run.finished`. An assistant message
does carry the provider's `stopReason` inside its own payload (see Reading history over REST), but
that is a property of one message, not a turn signal.

---

## The vocabulary

`SESSION_EVENT_TYPES` is exported as a runtime array of exactly these 19 entries, in this order.
The `types=` filter on the history read accepts only members of this list; anything else is
`400 invalid_request`.

| Type | What it means | Act on it? |
|---|---|---|
| `run.started` | A turn began, before any model call. `payload`: `trigger`, `inboundMessageId`, `agentId`. | Yes - mark the turn in flight |
| `run.finished` | The turn is over; the last event of the turn. `payload.status` is `succeeded` / `failed` / `aborted`. | Yes - the only verdict, and your loop exit |
| `chat.delta` | Preview lane, not the durable log. | No - see What not to build on |
| `chat.final` | Preview lane. | No |
| `chat.aborted` | Preview lane. | No |
| `chat.error` | Preview lane. | No |
| `agent.lifecycle` | Bookends the agent loop inside a turn. `start` and `end` are the recorded values of `phase`; the API reference declares a `heartbeat-skipped` phase for scheduled agents, which has not been observed here. | Rarely - useful for tracing |
| `agent.assistant` | One assistant message segment was committed. `payload.message` is `{ role, content[] }`, plus a 1-based `segment`. | Yes - this is the reply text |
| `agent.thinking` | Reasoning text for the segment just committed. `payload.text`. | Yes, if you render reasoning |
| `agent.tool` | A tool call changed phase. See Rendering below. | Yes - tool UI |
| `agent.item` | Internal loop markers (`kind`: `assistant_segment`, `llm_request`), not conversation. | No - skip when rendering a chat |
| `agent.plan` | Reserved in the vocabulary. The core loop does not emit it. | No |
| `agent.approval` | A tool call needs an approval, or one resolved. `phase`: `requested` / `resolved`. | Only for human-in-the-loop |
| `agent.command_output` | A command-running tool produced stdout/stderr, at result granularity. | Optional |
| `agent.patch` | An `apply_patch` tool call succeeded. | Optional |
| `agent.compaction` | History was compacted to fit the context window. `tokensBefore`, `reason`. | Telemetry only |
| `agent.error` | An error occurred inside the turn. `errorMessage`, sometimes `kind` and `server`. | Yes - log it, but it is not the verdict |
| `attachment.created` | A tool produced a file. `source`, `toolName`, `toolCallId`, storage refs. | Yes, if you surface files |
| `message.outbound` | The agent sent a proactive message (message tool, schedule announce, heartbeat) instead of replying in-session. | Only for proactive agents |

Six carry real integrations: `run.started`, `run.finished`, `agent.assistant`, `agent.thinking`,
`agent.tool` and `agent.error`. Handling only those renders a correct chat.

**Payload fields for the rarer types are a guide, not a contract.** The arc observed repeatedly on
live sessions is `run.started`, `agent.lifecycle`, `agent.item`, `agent.thinking`,
`agent.assistant`, `agent.tool` (start then end), `agent.lifecycle`, `run.finished`. `agent.approval`,
`agent.command_output`, `agent.patch`, `agent.compaction`, `attachment.created` and
`message.outbound` are emitted by the engine but have never been driven end to end through this
API, so code defensively against their fields.

---

## The read loop

`streamEvents` is an async generator, not a promise. The one thing you must get right: **the stream
is session-scoped and does not close when a turn ends**. `run.finished` ends the turn, not the
connection; the server holds it open for the next turn and drops it only after an idle period. A
`for await` that runs to completion - or an `await` on an array collected from the generator -
blocks until that idle timeout fires. Break on `isRunFinished(ev)` yourself.

```ts
import {
  createZooclawClient, assistantText, thinkingText, toolCall, isRunFinished, runOutcome,
} from '@zooclaw-agents/sdk'

const zc = createZooclawClient()                        // reads ZOOCLAW_API_KEY
const agentId = process.env.ZOOCLAW_AGENT_ID!           // agt_..., created and started once at setup

const session = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: 'What is our refund window?' }],
})

const ctl = new AbortController()
const budget = setTimeout(() => ctl.abort(), 120_000)   // a stuck run must not hang the process

let text = ''
let lastSeq = 0
let outcome: 'succeeded' | 'failed' | 'aborted' | undefined
const failedTools: string[] = []

try {
  for await (const ev of zc.streamEvents(agentId, session.session_id, { signal: ctl.signal })) {
    lastSeq = ev.seq                                    // the resume cursor - persist it
    text += assistantText(ev)                           // '' for every non agent.assistant event

    const think = thinkingText(ev)
    if (think) console.log(`[${ev.seq}] thinking: ${think.slice(0, 60)}`)
    const tool = toolCall(ev)
    if (tool?.phase === 'end' && tool.isError) failedTools.push(tool.toolName) // does NOT fail the run

    if (isRunFinished(ev)) {
      outcome = runOutcome(ev)                          // 'succeeded' | 'failed' | 'aborted'
      break                                             // required: the stream will not end on its own
    }
  }
} finally {
  clearTimeout(budget)
  ctl.abort()                                           // releases the HTTP body the generator left open
}
console.log(outcome, text.trim(), failedTools)
```

Mechanics worth knowing:

- `{ after: lastSeq }` is appended to the request only when `after > 0`, so passing `0` is the same
  as passing nothing. That is why `lastSeq` starts at `0` and is never reset.
- Aborting the signal ends the generator cleanly - the SDK swallows its own abort and returns
  instead of throwing, so you do not need a `catch` for your own cancellation. The flip side is in
  Reconnecting: a clean end no longer tells you which of the two things happened.
- The generator drops any event whose `seq` is at or below the highest it has already yielded, so a
  boundary event replayed by the server is never delivered twice within one generator instance.
- For a multi-turn session, open a fresh stream per turn with `{ after: lastSeq }` rather than
  holding one open and counting `run.finished` events. It is easier to reason about, and it is what
  the reconnect wrapper below assumes.

---

## Reconnecting

**The SDK does not reconnect for you.** `streamEvents` opens exactly one `GET .../events/stream`
request and the generator ends when that response body ends. There is no retry, no backoff and no
auto-resume anywhere in the SDK - looping is the caller's job, and an integration that omits the
loop looks fine in testing and then silently stops receiving events in production.

What the server gives you in exchange is server-side resume. Every durable frame carries its `seq`
in the SSE `id:` line; pass `{ after: lastSeq }` and the server replays the log from your cursor
before continuing live - no client-side buffer to keep, and no gap if the reconnect takes a while.
The server may re-send the boundary frame, and the generator drops anything at or below the highest
`seq` it has already yielded, so you do not write that check yourself. The one subtlety: a caller
abort and an idle server close both end the generator the same quiet way, so check the signal to
tell them apart or a user who cancelled gets reconnected to.

```ts
import {
  ZooclawError, assistantText, isRunFinished, runOutcome,
  type SessionEvent, type ZooclawClient,
} from '@zooclaw-agents/sdk'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

export interface TurnResult {
  outcome?: 'succeeded' | 'failed' | 'aborted'
  text: string
  lastSeq: number                       // valid to resume from even when outcome is undefined
}

export async function streamTurn(
  zc: ZooclawClient,
  agentId: string,
  sessionId: string,
  opts: { after?: number; signal?: AbortSignal; maxAttempts?: number; onEvent?: (ev: SessionEvent) => void } = {},
): Promise<TurnResult> {
  const maxAttempts = opts.maxAttempts ?? 6
  let lastSeq = opts.after ?? 0
  let text = ''

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // One controller per attempt: aborting it in `finally` frees the socket when we stop reading.
    const attemptCtl = new AbortController()
    const relay = () => attemptCtl.abort()
    opts.signal?.addEventListener('abort', relay, { once: true })
    if (opts.signal?.aborted) attemptCtl.abort()

    try {
      for await (const ev of zc.streamEvents(agentId, sessionId, {
        after: lastSeq,             // server replays from the cursor; a repeated boundary frame is dropped
        signal: attemptCtl.signal,
      })) {
        lastSeq = ev.seq            // advance BEFORE anything that can throw
        text += assistantText(ev)
        opts.onEvent?.(ev)
        if (isRunFinished(ev)) {
          const outcome = runOutcome(ev)
          return { ...(outcome ? { outcome } : {}), text, lastSeq }
        }
      }
      // Generator ended without run.finished. Either the caller aborted (checked below) or the
      // server closed an idle connection - the normal case, and not an error.
    } catch (e) {
      // 4xx is a real problem: unknown id, archived session, revoked key. Retrying cannot fix it.
      if (e instanceof ZooclawError && e.status >= 400 && e.status < 500) throw e
      // Everything else - socket reset, 5xx, DNS - is worth another attempt.
    } finally {
      opts.signal?.removeEventListener('abort', relay)
      attemptCtl.abort()
    }

    if (opts.signal?.aborted) return { text, lastSeq }   // caller cancelled: do NOT reconnect
    await sleep(Math.min(1_000 * 2 ** attempt, 15_000), opts.signal)
  }

  return { text, lastSeq }          // out of attempts; lastSeq still resumes the same turn later
}
```

A non-2xx on the stream open throws `ZooclawError(status, 'events stream HTTP <status>')` with
**no** `type` field, so match on `.status` here, never on `.type` or the message. Calling the HTTP
endpoint directly, `?after=<seq>` is the resume parameter the SDK sends and the only one that has
been exercised. The server writes the `id:` line, so a browser `EventSource` will send
`Last-Event-ID` on its own; whether the server honours that header has not been verified, so pass
`?after=` explicitly rather than relying on it.

---

## Reading history over REST

`listEvents(agentId, sessionId, opts?: { after?: number; types?: string[]; limit?: number })` reads
the same durable log the stream reads and returns the same normalized `SessionEvent[]`; text
assembled from a REST replay is identical to text assembled from the stream. But it returns
**one page**. `limit` defaults to 100 server-side and is capped at 500, and a full page
is truncated silently - there is no `has_more`, no total, and no next cursor in the response. A
session with 600 events answers with 500 of them and looks complete. That silent truncation is why
`listAllEvents` exists:

```ts
const all = await zc.listAllEvents(agentId, sessionId)   // ascending seq, deduped across pages
const replies = await zc.listAllEvents(agentId, sessionId, { types: ['agent.assistant'] })
```

`listAllEvents` walks the `after` seq cursor - it is not a page-number pager. It stops when a short
page arrives or when the highest `seq` in a page fails to advance the cursor, so a server that
ignored `after` returns a duplicate page instead of spinning forever. `types` is joined into one
comma-separated query parameter and filtered server-side; every entry must be a member of
`SESSION_EVENT_TYPES` or the call is `400 invalid_request`. Reach for `listEvents` directly only
when you are paging by hand, or want the last window of a session you know is under 500 events.

### When the transcript is the better read

`getSession(agentId, sessionId, { history: true, limit })` returns the **at-rest transcript**, not
the event log: `history?: SessionHistoryEntry[]`, each `{ seq, entry_type, entry, created_at }`, the
most recent `limit` rows in ascending `seq`. The SDK forwards `limit` verbatim and pins no default
and no maximum for this surface, so pass one explicitly rather than assuming the `listEvents`
numbers apply here.

```ts
import { messageText } from '@zooclaw-agents/sdk'

const s = await zc.getSession(agentId, sessionId, { history: true, limit: 50 })
const transcript = (s.history ?? [])
  .filter((row) => row.entry_type === 'message')       // other entry_types are anchors, compaction
  .map((row) => messageText(row.entry.message))        // entry.message is { role, content }, not payload
```

**The transcript has no cursor.** `limit` selects the most recent rows, and this surface takes no
`after` and no offset, so an older window of a long session is not reachable through it. The event
log does not make up the difference either: `SESSION_EVENT_TYPES` has no user-message type, so
`listAllEvents` gives you the assistant side only. If you need a complete two-sided export of a long
session, keep the record yourself - persist each `user.message` you post alongside the
`agent.assistant` events you read - and say so rather than shipping an export that silently starts
in the middle.

Two things are easiest to read here:

- **Token usage.** `entry.message.usage` carries `input`, `output`, `cacheRead`, `cacheWrite` and
  `totalTokens`. The same block also rides on every `agent.assistant` event at
  `payload.message.usage`, so the transcript is the convenient read, not the only one. `usage.cost`
  is an **object** with those same keys, recorded as all zeros, so do not build a spend display on
  it.
- **The model that actually served the turn.** `entry.message.model` is what the agent is
  configured with; `responseModel` is what answered. They can differ when the deployment maps a
  model to a substitute, so trust `responseModel`. Both appear on the `agent.assistant` event
  payload too.

An assistant row also carries the provider's `stopReason` - and so does the `agent.assistant` event,
at `payload.message.stopReason`. It is a property of one message, not a turn signal: turn success
still comes only from `runOutcome`. Use the transcript to recover an answer whose events you missed
and the event log when you want the run; the transcript holds conversational messages, never
`run.started` / `agent.tool` / `run.finished`.

---

## Rendering

Every helper is a pure function over a `SessionEvent` that returns a harmless empty value for the
wrong event type, so you can call them all unconditionally in one loop.

| Helper | Returns | Empty value |
|---|---|---|
| `assistantText(e)` | Text of an `agent.assistant` event | `''` |
| `thinkingText(e)` | Reasoning text of an `agent.thinking` event | `''` |
| `toolCall(e)` | A `ToolCall` for an `agent.tool` event | `undefined` |
| `isRunFinished(e)` | `true` for `run.finished` | `false` |
| `runOutcome(e)` | `'succeeded' \| 'failed' \| 'aborted'` | `undefined` for any other event, and for an unrecognized status |
| `messageText(m)` | Text of a `{ role, content }` object | `''` |

`messageText` is the odd one: it takes a message, not an event, because it also serves transcript
rows where the message sits at `entry.message`. `content` is normally an array of blocks and only
`{ type: 'text', text }` blocks carry text - tool-use and thinking blocks do not - so reaching into
`content[0].text` yourself returns an empty string on many real messages. A plain string `content`
is accepted too; that is how write-side `user.message` content comes back.

```ts
interface ToolCall {
  phase: 'start' | 'end' | 'blocked'
  toolName: string
  toolCallId: string
  args?: Record<string, unknown>      // on start
  isError?: boolean                   // on end
  resultPreview?: string              // on end
}
```

Three rules, each of which is a bug someone has already shipped:

1. **Pair by `toolCallId`, not by adjacency.** One call produces multiple `agent.tool` events
   sharing a `toolCallId`. When calls run concurrently the `start` and `end` of one call are
   separated by events belonging to others, so a renderer that assumes the next `agent.tool` closes
   the previous one attributes results to the wrong tool. Keep a `Map<string, ToolCall>` keyed by
   `toolCallId` and delete on `end`.
2. **`blocked` is pending, not complete.** It means an approval gate stopped the call *before*
   execution; the matching `agent.approval` event carries the request, and an `end` still follows
   once it resolves. Rendering `blocked` as finished reports work that never happened - `start` and
   `blocked` are both still in flight. Human-in-the-loop approval has not been proven end to end;
   read `references/not-supported.md` - End-to-end human approval before designing around it.
3. **`isError` does not fail the run.** An `agent.tool` `end` with `isError: true` is routinely
   followed by `run.finished` with `status: 'succeeded'` - the model saw the tool error, worked
   around it, and answered. The inverse also holds: do not infer success from the absence of tool
   errors. Collect tool failures separately and report them *alongside* `runOutcome`, never instead
   of it.

`toolCall()` maps any phase it does not recognize onto `start`, so if you need the exact wire value,
read `ev.payload.phase`.

---

## Writing into a session

Exactly four event types can be posted, and a type outside the four does not reach the agent. The
error `type` string for a rejected write has not been recorded, so read the per-event `accepted`
flag in the response rather than assuming a throw, and if you do match an error, match on `.status`.
Signature: `postEvents(agentId, sessionId, events: OutboundEvent[])` - the agent id comes first on
every session method, because the route is `/agents/{id}/sessions/{sid}/events`.

| Type | Body | Effect |
|---|---|---|
| `user.message` | `content` (non-empty **string**). The API reference also declares an optional `attachments[]` and `idempotency_key`; neither has been exercised here | Appends a user turn and starts a run |
| `user.interrupt` | no other fields | Aborts the in-flight run; that run ends `run.finished` with `status: 'aborted'` |
| `user.tool_confirmation` | `approval_id`, `decision`: `allow-once` / `allow-always` / `deny` | Resolves a pending approval |
| `system.message` | `text` (non-empty string) | Injects a note the model reads on the **next** turn |

```ts
const res = await zc.postEvents(agentId, sessionId, [
  { type: 'system.message', text: "Operator note: the user's plan is Enterprise." },
  { type: 'user.message', content: 'Which limits apply to me?' },   // a plain string is what has been exercised
])
if (res.events[0]?.accepted !== true) { /* the event did not take - inspect before streaming */ }
```

`postEvents` answers `202` with one entry per submitted event, `{ id?, type?, accepted? }`.
`accepted` is the field that matters: `202` alone means queued, not that a turn happened.

`system.message` lands in context on the *following* turn, not the current one, so post it before
the `user.message` it should affect. It is the supported way to hand an agent state your application
owns, since there is no memory resource to write.

`user.interrupt` with **no** run in flight answers `accepted: false` at HTTP `202`. That is a no-op,
not an error - code that expects a thrown exception there has a cancel button that breaks whenever
the agent happens to have already finished.

`createSession(agentId, { initial_events })` has been exercised only with a single `user.message`,
and `user.message` is the only type the API reference says it takes there; the SDK's parameter type
(`OutboundEvent[]`) is wider than the route. Keep it to the opening message and post everything else
with `postEvents` once the create returns.

Nothing on the approval path has been observed end to end - no `agent.approval` event has been
recorded and every recorded `approvals` list is empty - so the id's field name on both sides of the
`user.tool_confirmation` round trip is unverified. Read `references/not-supported.md` - End-to-end
human approval before writing this.

---

## What not to build on: the delta preview lane

`chat.delta`, `chat.final`, `chat.aborted` and `chat.error` are members of the vocabulary but are
**not written to the durable event log**. They live on a separate, short-lived per-run preview lane
reached only by a query parameter that the SDK never sends, and `streamEvents` additionally drops
any frame it sees named `event_delta`. Everything the SDK yields is durable.

Porting streaming UI code, this is the trap: those preview frames carry `"replace": true`, meaning
**snapshot-replace** - each frame holds the current full text, not the newly added fragment.
Append-style delta logic that is correct against a prefix-append API produces text duplicated once
per frame here. Assign, never concatenate. Preview frames also carry no `id:` line, so they sit
outside the resume cursor entirely and never replay; a reconnect re-derives them from the next
`run.started`.

The lane is unverified against a live deployment, may answer `501 not_configured`, and is not part
of the durable contract. Build finished text from `agent.assistant` events through `assistantText`,
which is durable, resumable and verified - and if a caller genuinely needs token-level streaming,
say that this API does not offer it in a supported form rather than shipping the delta lane.

For the full method list and return shapes, read `references/typescript-sdk.md` - Events.
