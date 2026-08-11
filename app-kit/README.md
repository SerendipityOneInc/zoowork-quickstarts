# app-kit

> A template in [ZooClaw Quickstarts](../README.md). This is the **production reference** —
> auth, persistence, and a streaming experience that survives refresh and reconnect. It is
> the deepest template here, not the shortest path to a first message.

A reusable, **business-free** host-side template for building agent-native apps on
**the ZooClaw API** (managed agents + sandboxed sessions). The kit plays the
**gateway-client role**: Cloudflare Access verifies the browser user; the Worker then
talks to the ZooClaw API with ONE trusted service bearer and declares the verified identity as
data anchors (`ownership.owner_uid = email:<email>`, `org_id` from env). Its whole job is
to make that interaction — **agent provisioning + session turns + streaming experience** —
clean, robust, and reusable, so a new vertical service can be spun up fast by filling a
thin `domain/` seam.

- **Default deploy:** Cloudflare Workers + D1 + Durable Objects + Cloudflare Access.
- **Portable by design:** storage + execution behind swappable seams (`Store` interface,
  turn-runner as an injected function).
- **Trust boundary:** the service token lives ONLY in the Worker/DO. Nothing in `src/`
  (the browser bundle) ever sees it — the ZooClaw API does no end-user auth, so leaking the
  token means leaking every user's agent.

> > architecture — frames-as-source, Store seam, alarm-driven DO windows, refresh-safe SSE —
> is unchanged; only the backend client and the provisioning layer (Managed Agents
> replacing agent-computer/seed) were swapped.
>
> **The wire client is now [`@zooclaw-agents/sdk`](https://www.npmjs.com/package/@zooclaw-agents/sdk)**, not a hand-rolled
> one. The kit's own `server/zooclaw/` is down to a single file — `turn-driver.ts`, which
> turns session events into frames. Everything below it (HTTP, SSE parsing, the two
> different event envelope shapes, `run.finished` detection) belongs to the SDK, which is
> the point: the SDK is what an external developer gets, and the kit is its first
> consumer, so a gap in the SDK shows up here first.

## What it makes easy (the three goals)

1. **Plug in existing resources** — a registry Skill (`skl_...` pin), a persona, tool
   toggles — through the thin `domain/` seam, without touching the ZooClaw API plumbing.
2. **Wire up the ZooClaw API fast and keep it stable** — provisioning + the external Session API
   + a streaming experience that is *already* correct under refresh, resume, and
   slow-settling turn ends.
3. **Re-skin the UI freely** — the kit ships a deliberately minimal UI; the load-bearing
   promise is that the API-interaction layer beneath it stays rock-solid no matter
   how the UI is rebuilt.

## Status

**Running against staging end-to-end (2026-08-05):** send a message, watch the reply
stream, follow up in the same session, tool calls render, refresh rebuilds. The wire
contract is the [API reference](https://github.com/SerendipityOneInc/zoowork-agents-docs) (Developer
Preview); the two biggest **[verify]** items — the durable event shape and whether a
turn-terminal event exists — are now resolved there. The rest of the list is in
[Before you rely on it](#before-you-rely-on-it).

Out of the box, the demo gives you:

- **Multiple conversations** — a per-user conversation list; each deep-links via `?t=…`.
  One conversation = one **Zooclaw session**, so the hosted agent keeps context across
  turns without the kit re-sending history.
- **Streaming chat** — assistant text streams in live (SSE that tails the store, so a
  refresh mid-turn rebuilds losslessly).
- **Per-user agent, provisioned lazily** — the first turn creates the user's Managed
  Agent, and starts it; later turns reuse it (cached in D1).
- **Set the system prompt / toggle tools / pin a skill** — edited in the panel's Config
  tab, applied to the user's agent as persona (`AGENTS.md`) + `tool_policy` + a skill pin,
  drift-gated so unchanged config never causes a version-bumping PUT.
- **Pick which agent you talk to** — the panel's Agent tab lists the agents your key can
  see and binds one for your next new chat, so trying an agent you built in the ZooClaw app
  costs no redeploy. On by default; close it with `AGENT_PICKER=off` before shipping to end
  users — see [Three ways to get an agent](#three-ways-to-get-an-agent).
- **Human-in-the-loop answer (OUTBOUND half only)** — the answer path is wired: an
  in-chat answer posts a `user.tool_confirmation` event into the session and nudges the
  runner. The INBOUND half is NOT: nothing produces the `__ask` frame the AskCard renders,
  so an agent that blocks on a confirmation today just times the turn out. The event to
  map is `agent.approval` (`phase: 'requested'`); what's unsettled is how its `approvalId`
  pairs with the card's `messageId`/`actionId`. See the [verify] list below; the mapping
  slot is `server/zooclaw/turn-driver.ts`.

## Quickstart

Requires **Node >= 22** (wrangler 4); `.node-version` pins it. You need one thing: an
org API key (`zct_...`).

```bash
cp .dev.vars.example .dev.vars    # then paste your key into ZOOCLAW_API_KEY
pnpm install
pnpm db:migrate:local             # create the local D1 tables (idempotent)
pnpm dev                          # vite + wrangler dev
```

That is the whole setup: **one value to fill in, three commands.** Everything else has a
working default - the SDK knows the API endpoint, and the gateway assigns your tenant and
seeds each new agent's model credentials for you.

`DEV_EMAIL` in the example file stands in for Cloudflare Access so you are signed in
locally. Leave it out in production: without it, and without Access configured, every
request is rejected.

Ports default to 4000 (vite) and 8787 (worker). Both move together via `KIT_VITE_PORT`
and `KIT_WORKER_PORT` - set them if something else on your machine holds those.

### Optional variables

None of these are in `.dev.vars.example`, and none are needed to run the kit. Add them to
`.dev.vars` only if you want the behaviour described.

| | |
|---|---|
| `ZOOCLAW_AGENT_ID` | Fixed-agent mode - see [Three ways to get an agent](#three-ways-to-get-an-agent) below. |
| `AGENT_PICKER` | **On by default.** Set `off` to close the panel's **Agent** tab picker, so nobody can rebind and everyone uses the mode below. See the note under [Three ways to get an agent](#three-ways-to-get-an-agent). |
| `ZOOCLAW_API_URL` | Point at a different deployment. Unset, the SDK uses the public gateway. |
| `EMBED_KEY` | Shared gate key for embedding. When set, every `/api/app/*` call must present it (`X-Embed-Key` header or `?k=` query) or gets 401. |

### Three ways to get an agent

| | user-bound (default) | `ZOOCLAW_AGENT_ID` set | neither |
|---|---|---|---|
| what happens | the user picks an agent they already own, in the Agent tab | everyone shares that one pre-built agent | each user gets their own agent, created on first use |
| good for | trying your own agents against the kit with no redeploy | a demo, or one agent for the whole deployment | anything multi-user |
| needs | just the key | just the key | just the key - the gateway seeds the credentials |

They are a fallback chain, not alternatives: **binding → `ZOOCLAW_AGENT_ID` → per-user**.
A binding only affects that user's **next new chat**. Open conversations never move — the
first turn pins its agent in `tasks.agent_id`, because a Zooclaw session exists only on the
agent that created it (`migrations/0002`).

Two rules the picker is built around:

- **A borrowed agent is used, never written.** Bound and `ZOOCLAW_AGENT_ID` agents skip
  every config PUT (`worker/provision.ts`) — they belong to whoever built them, and a PUT
  would rewrite their persona and bump `config_version`. The Config tab goes read-only to
  say so. Only the kit's own per-user agent is configurable.
- **Close the picker before you ship to end users.** `ZOOCLAW_API_KEY` authenticates your
  whole organization, so with the picker on **any** signed-in user can list and borrow
  **any** agent in the org. That is the point while you are learning the SDK against your
  own agents, and wrong once strangers can sign in — `AGENT_PICKER=off` shuts both the
  routes (403) and the resolver (stored bindings are ignored, so it revokes rather than
  grandfathers).

> The agent **list** needs the gateway to forward collection-level `GET /agents`. Where it
> does not, the Agent tab says so and takes a pasted `agt_…` id instead (validated through
> `getAgent()` before it can be saved) — the picker works either way.

The list drops one kind of row: **Agent Builder test runs** (`pack_test_run_id` /
`source: agent_builder`), which are throwaway instances carrying the same name, persona and
skills as the pack they were testing — two identical rows is a worse answer than one. The
count of what was dropped is shown under the list, and the filter keys on the test-run label
rather than on a missing `workspace_id`, because the kit's own per-user agents have no
`workspace_id` either (`worker/agent-directory.ts`).

## Architecture

### Layering (the spine — see the layering notes below)

| Tier | What | Owner |
|------|------|-------|
| **Zooclaw platform** | the ZooClaw API (agents, credentials, sessions, skills registry) + protocol behavior | Zooclaw |
| **the SDK** | the wire: HTTP, SSE, event normalization, `run.finished` (`@zooclaw-agents/sdk`) | [`@zooclaw-agents/sdk`](https://www.npmjs.com/package/@zooclaw-agents/sdk) |
| **the kit** | Access handoff · `Store` · turn-runner · **streaming experience** · provisioning | this repo |
| **vertical app** | `domain/` only (persona · tool toggles · skill pin · cards / right pane) | each app |

### Provisioning (per user, lazy — `worker/provision.ts`)

Skipped entirely in fixed-agent mode (see Quickstart). Otherwise the first turn walks the
documented bring-up order, then caches the agent id by email in D1:

1. `POST /v1/agents` with a **stable Idempotency-Key** (`zooclaw-app-kit:agent:<email>`)
   so concurrent first-turns converge on one agent. Created with `warm: true` (pre-warmed
   sandbox — the first message doesn't pay the cold start) and onboarding skipped (a chat
   app wants the configured persona, not a BOOTSTRAP interview turn).
2. The API seeds the agent's model credentials for you at create time - the kit writes none.
   platform credentials `start` requires.
3. `POST .../start` (self-heals a 409 `platform_credentials_required` by writing
   credentials and starting again).

Session config (persona + tool_policy + skill pin) is applied as a follow-up PUT, gated
by a config fingerprint — the ZooClaw API PUTs bump `config_version` on EVERY call, so the kit
only PUTs actual drift.

### Turn lifecycle (the external Session API — `worker/task-do.ts`)

One Zooclaw session per conversation. The first turn creates it with the prompt as
`initial_events: [{type:'user.message', ...}]`; follow-up turns `POST .../events` into
the same session. Streaming rides `GET .../events/stream` (SSE) with `?after=<seq>`
resume; a turn is driven in bounded ~20s Durable Object alarm windows, each resuming from
the persisted event cursor.

**Turn end is `run.finished`.** It is the terminal run boundary and carries
`payload.status: succeeded | failed | aborted`. The session stream is still per-session and
unbounded (it does not close at turn end), so a window can end *without* seeing it — a
dropped SSE connection, the window timer, the idle short-circuit. For those, the
session-status poll (`GET .../sessions/{id}` reporting an at-rest `idle`) remains as a
backstop, with the two races it implies (status lags the submitted message; status flips
idle before the tail lands) guarded by the pure drain/expiry helpers in
[`worker/turn-finalize.ts`](worker/turn-finalize.ts). Cancel posts `user.interrupt`
(best-effort) and finalizes locally.

Known accepted window: a retried submit after a lost 202 can double-send one
`user.message` — session *create* is idempotent (keyed by promptId), event POSTs are not.

### Streaming experience (the crown)

**The source of the stream is the database, not the connection.** Every session event is
translated (`server/zooclaw/turn-driver.ts`) into frames appended to the `Store`; the
browser's SSE tails the store by seq (`Last-Event-ID` resume), and a refresh rebuilds the
whole conversation from frames — so "refresh mid-turn" and "close the tab while it runs"
are naturally lossless. The backend runs the turn independently in the DO. Self-heal
paths backfill an answer that settled after the turn finalized (from the session
transcript, `history=true`).

### Attachments: DISABLED (deliberately)

`domain/agent.ts ATTACHMENTS_ENABLED = false`. Zooclaw's Files API is a text-content
JSON contract marked *Not production-wired* — there is nowhere to stage binary uploads
yet. The upload route 501s; the display plumbing (store + bubble rendering) stays intact
so a vertical can flip it on when the shared-workspace rollout lands.

## Before you rely on it

The wire contract carries **[verify]** markers — shapes the docs did not pin down.
Confirm each against your staging the ZooClaw API before shipping
(details in the [API reference](https://github.com/SerendipityOneInc/zoowork-agents-docs)):

- the create-time flag spelling for skipping onboarding (`onboarding: false`);
- whether `user.message` content accepts richer blocks than a plain string;
- the exact `user.tool_confirmation` payload fields (the kit's HITL answer path);
- the tool_policy deny-key spelling (`domain/agent.ts buildToolPolicy`).

Two items came OFF this list on 2026-08-05, verified against staging: the durable event
JSON shape (two different envelopes, REST snake_case vs SSE camelCase — the SDK absorbs
both), and the supposed absence of a turn-terminal event (`run.finished` is one).

## Deploy

```bash
wrangler d1 create zooclaw-app-kit        # then paste database_id into wrangler.jsonc
pnpm db:migrate                            # apply migrations to the remote DB
wrangler secret put ZOOCLAW_API_KEY        # gateway mode — the only secret you need
pnpm build && wrangler deploy
```

Non-secret vars (`ZOOCLAW_API_URL`, `ZOOCLAW_ORG_ID`, optional `ZOOCLAW_ENVIRONMENT_ID`,
optional `ZOOCLAW_AGENT_ID`) go in `wrangler.jsonc` `vars`. Cloudflare Access setup is
unchanged from the standard pattern: create an Access application in front of the
Worker's domain, then set `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` so
[`worker/auth.ts`](worker/auth.ts) can verify the JWT. Never set `DEV_EMAIL` in prod.

## Caveats

- **Developer Preview backend.** the ZooClaw API's API is pre-stable; treat the [verify] list
  above as a pre-ship checklist, and the API reference as the file to
  update first when the docs move.
- **Fixed-agent mode is single-tenant.** Everyone shares one agent's config. It also means
  the agent's own tools can rewrite its persona docs mid-conversation (a bootstrap turn
  will) — that's the agent acting, not the kit, but it's a real agent you're borrowing.
- **Skill un-pin is not reconciled.** Clearing a previously pinned skill id does not
  uninstall it from the agent (the kit fingerprints config, not skill history) — a
  vertical needing precise skill lifecycle should diff against the agent's skill list.
- **No seed tree.** Unlike a naive relay, agents get capabilities from the platform
  **skills registry** (pinned by `skl_...` id), not from a host-pushed file tree; there
  is nothing to `gen:seed`.

