# Working on the `chat` quickstart

Things that are not obvious from the API docs and cost real debugging time. Every claim
here was verified against a live deployment on 2026-08-11, not read off a spec.

---

## Mental model

The server holds one secret and one token. `ZOOCLAW_API_KEY` authenticates the whole
organization, so it can never reach the browser — that is the entire reason a server
exists in a template with no database. The token is a per-session stream resume cursor
(`cursors` in `server.mjs`), so a new turn streams only new events.

Everything else lives in ZooClaw. The browser stores a session id in `localStorage`; the
transcript is fetched back from the platform on reload. There is nothing to persist.

---

## The event log IS the conversation

The log is bidirectional: what you post echoes back as `user.message` events — with a
`processedAt` that flips from `null` to a timestamp once the agent consumes it —
alongside the agent's `agent.assistant` replies. One filtered read rebuilds the whole
two-sided transcript, for a session of any length, from any device:

```js
const events = await zc.listAllEvents(agentId, sessionId, {
  types: ['user.message', 'agent.assistant'],
})
// user rows:      messageText(ev.payload)          — payload is { content: [...] }
// assistant rows: messageText(ev.payload.message)  — payload.message is { role, content }
```

`messageText` reads the text blocks and skips the model's `thinking` scratchpad blocks on
its own. This template's `/api/history` is exactly that loop.

`getSession(agentId, sessionId, { history: true })` still exists — the at-rest transcript
is where per-turn token usage and the model that actually answered live — but it returns
only the most recent rows, takes no cursor, and is no longer needed to render a chat.

Resume tokens: every streamed event carries `ev.cursor`. Persist the last one and pass
`{ cursor }` to `streamEvents` to continue exactly where you stopped. Tokens are opaque —
never mint one from a `seq`; when you have none (fresh process), stream from the start
and drop events at or below the last `seq` you already rendered, as `streamTurn` here
does.

---

## There is no token-by-token streaming

A whole reply arrives as **one** `agent.assistant` event. Asked to count from 1 to 40,
the run emitted exactly one text event, 112 characters, ~5 seconds in. The SDK skips
`event_delta` frames outright.

So do not build a typing cursor. What you *can* show, because these events are real and
arrive before the reply:

- `agent.thinking` → "thinking…"
- `toolCall(ev)?.phase === 'start'` → `using ${call.toolName}…`

Tool names are only observable at runtime; there is no catalog route. `web_search` is
confirmed to exist and fire.

---

## Starting the agent

Sessions require `desired_state === 'running'`. An agent built in the workspace UI is
normally already running, so the preflight is usually one GET — but an agent that was
stopped needs `startAgent()`, and without it every `createSession()` returns
`409 agent_not_running`.

**Poll `desired_state`, never `actual_state`.** `actual_state` tracks chat-channel
connectivity; an API-only agent parks at `activating` forever and `running` is not even
in its enum. A loop waiting on `actual_state` never returns.

`startAgent()` returns a `channel_routes_reload_failed` warning for API-only agents.
Expected, harmless, not a failure — read `desired_state` instead.

---

## Sessions

- **Creating a session and sending the first message are one call.** Pass
  `initial_events: [{ type:'user.message', content }]`; do not create then post.
- **Follow-ups go to the same session** via `postEvents()`. Never re-send history.
- **`metadata` round-trips verbatim** and shows up in `listSessions()` rows — the only
  clean place to put a title, since sessions have no `title` field and `PATCH` is 405.
  It is written at create time, so a title derived from the first message means the
  session must be created lazily on first send, not when a "new chat" button is clicked.
- **`postEvents()` returns `{events:[{id, type, accepted}]}`,** and that `id` appears
  verbatim as the next `run.started.payload.inboundMessageId`. That is how you tie a
  submitted message to the run it started, if you ever need to.

---

## Ending a turn

`run.finished` ends the **turn**, not the stream. The stream is scoped to the session and
stays open; break out of the loop yourself or you block until an idle timeout.

`runOutcome(ev)` is `succeeded | failed | aborted`. A run can finish `succeeded` with
failing tool calls inside it — read the outcome and the tool trace as independent
signals.

---

## Errors worth special-casing

| | |
|---|---|
| `401` | key missing or invalid. Match on `ZooclawError.status`, never on message text. |
| `404` on an agent id you hold | almost always cross-organization: the key and the agent belong to different orgs. Tenant isolation hides existence rather than returning 403, so 404 does **not** mean "deleted". |
| `409 agent_not_running` | preflight was skipped, or the agent was stopped after boot. |

---

## If you extend this

- **A session sidebar is available.** `listSessions(agentId)` returns
  `{session_id, session_key, channel, run_status, updated_at, metadata, archived}` — enough
  for a sidebar with titles, without a database. It was left out to keep this template at
  one conversation.
- **Do not add a database before you need one.** Sessions, transcripts and titles all live
  in ZooClaw already. [`app-kit/`](../app-kit/) adds storage because it also adds auth,
  multi-user agents and refresh-safe streaming — reach for it then, not sooner.
- **Long-lived SSE at scale is untested.** Rate limits, concurrency caps and how the
  gateway treats connections held for many minutes have not been measured. One tab per
  user is fine; a room full of them is unproven.
