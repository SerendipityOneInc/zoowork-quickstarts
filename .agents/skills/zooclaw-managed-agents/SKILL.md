---
name: zooclaw-managed-agents
description: Build on ZooClaw Managed Agents - hosted AI agents that run in a managed sandbox, driven from your own code through the `@zooclaw-agents/sdk` TypeScript SDK. Use this skill whenever ZooClaw is mentioned; on any `zct_` key, `agt_` or `skl_` id, `ZOOCLAW_API_KEY`, `ZOOCLAW_BASE_URL`, `@zooclaw-agents/sdk`, `createZooclawClient`, `waitUntilRunning`, `putAgentSkill`, or the ZooClaw App Kit; on the errors `agent_not_running`, `environment_locked`, `session_archived`, `exec_requires_agent_scope`, or `environment_not_ready`; and when someone wants a ZooClaw agent they built locally, with its skills, hosted somewhere it can serve real users. Read it before writing any ZooClaw call - ported code compiles and then fails at runtime. This is NOT Anthropic's Claude Managed Agents (`@anthropic-ai/sdk`, `client.beta.agents`), which is a different product this skill does not cover.
license: MIT
---

# Building on ZooClaw Managed Agents

**The five that break code which compiles. If you read nothing else here, read these.**

1. `createAgent` leaves the agent **stopped**. Call `startAgent(id)` then `waitUntilRunning(id)`, or
   every session call answers `409 agent_not_running`.
2. Every session method takes **`agentId` first**: `createSession(agentId, ...)`,
   `postEvents(agentId, sessionId, ...)`, `streamEvents(agentId, sessionId, ...)`.
3. Set **`onboarding: false`** on create, or the agent's first turn interviews you about its own
   persona instead of answering.
4. Reply text comes from `agent.assistant` via **`assistantText(ev)`** - never from `chat.delta`,
   which is snapshot-replace and never reaches you anyway.
5. The stream **does not close at turn end**. `break` on `isRunFinished(ev)` or you block until the
   server's idle timeout.

ZooClaw hosts the agent loop and the sandbox its tools run in. You create an agent (a persistent,
versioned configuration), start it, then open sessions against it and read a durable event stream.
Your code owns the product; the platform owns the loop, the container, and the transcript. The API
is a Developer Preview: shapes can change within a version, and the reference files mark which
surfaces have been exercised against a live deployment and which have not.

Decide two things before writing code: **which path** the user is on (below), and **whether what
they want actually exists here** (`references/not-supported.md` - check it before designing, not
after the first integration test).

## Before you start

**Confirm this is ZooClaw.** The API is shaped like Claude Managed Agents and the two are easy to
conflate. If the file you are about to edit imports `@anthropic-ai/sdk` and calls
`client.beta.agents` / `client.beta.sessions`, that is Anthropic's product, not this one - stop and
ask which platform they mean rather than mixing the two SDKs in one file.

**The package is `@zooclaw-agents/sdk`.** Not `@zooclaw/sdk`, not `@zooclaw/agents-sdk`. Those names
have never existed on npm, and guessing one sends the user to a 404.

**The key.** One credential authenticates everything: an organization service token that starts with
`zct_`, passed as `apiKey`. An organization administrator issues it - there is no self-serve signup
page, so if the user does not have one yet, that is a person to ask, not an endpoint to call. It
authenticates the whole organization with full read and write over every agent in it, so it belongs
on a server the user controls and never in a browser bundle, a mobile app, or a build-time inlined
variable.

```bash
export ZOOCLAW_API_KEY='zct_...'
```

`listModels()` is the cheapest proof a key works: it touches no agent and creates nothing.

## Which path

| The user has | Give them | Why |
|---|---|---|
| A key, and wants a working agent UI today | **ZooClaw App Kit** - clone, paste the key, three commands | A deployable chat app with auth, persistence, streaming, and reconnect already solved |
| Their own front end, or an agent design of their own | **The SDK, directly** | Full control; you write the integration around sessions and events |
| An agent they built locally that has nowhere to run | **The SDK** - see `references/deploy-your-agent.md` | Their persona and skills become a hosted agent; their UI keeps talking to their own backend |

### The App Kit path

`https://github.com/SerendipityOneInc/zoowork-app-kit` is a Cloudflare Workers chat application that
already consumes this SDK. It provisions an agent on first use, so the user needs no `agt_` id.

```bash
cp .dev.vars.example .dev.vars    # paste the zct_ key into ZOOCLAW_API_KEY
pnpm install
pnpm db:migrate:local
pnpm dev                          # UI on http://127.0.0.1:4000
```

Node 22 or later (the App Kit's floor; the SDK itself needs only Node 20). `ZOOCLAW_API_KEY` is the
only value to fill in. Before shipping it to real users, two things must change: set
`AGENT_PICKER=off`, and put Cloudflare Access in front of the Worker
(`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`) instead of the local `DEV_EMAIL` shortcut, which trusts
whoever connects. When someone asks to customize the App Kit rather than call the API, read its
README first - the answer is usually a file it already has.

---

## The mandatory flow

| Step | Call | Frequency |
|---|---|---|
| 1 | `createAgent(...)` then `startAgent(id)` | **Once.** At setup, or in a provisioning path guarded by an idempotency key. Store the `agent_id` |
| 2 | `createSession(agentId, ...)` | **Every conversation.** |
| 3 | `postEvents(...)` / `streamEvents(...)` | **Every turn.** |

An agent is a stored object, not a per-request construct. If you are about to write `createAgent()`
in the same function that answers a user message - stop. Creating one per request makes a new agent,
with its own workspace and sandbox, on every call. It belongs in setup, and the id belongs in the
user's database.

```ts
import {
  createZooclawClient,
  assistantText,
  isRunFinished,
  runOutcome,
} from '@zooclaw-agents/sdk'

// Reads ZOOCLAW_API_KEY. Throws at construction if no key resolves, rather than 401-ing later.
const zc = createZooclawClient()

// 1. Ask which models this deployment carries. A recalled id is a 400, not a fallback.
const models = await zc.listModels()
const model = models.find((m) => m.model.includes('sonnet'))?.model ?? models[0]?.model
if (!model) throw new Error('no models available to this key')

// 2. Create. `ownership` is required by the schema and then overwritten by the gateway with the
//    tenant your key belongs to - send placeholders, do not go hunting for real ids.
const created = await zc.createAgent(
  {
    resource: {
      name: 'support-agent',
      model: { primary: model },
      // persona.docs is an ARRAY of documents, not a filename-keyed object.
      persona: { docs: [{ name: 'AGENTS.md', content: 'You answer questions about our billing policy.' }] },
      // Set this on every API-driven agent. Without it the agent spends its first turn
      // interviewing you about its own persona instead of answering. Create-time only.
      onboarding: false,
    },
    ownership: { owner_uid: 'placeholder', org_id: 'placeholder' },
  },
  // A stable idempotency key, not a per-run uuid. Two agents means two sandboxes and two
  // workspaces, and nothing in the product cleans the spare one up.
  'support-agent-v1',
)
const agentId = created.agent_id // agt_... - persist this, it is the handle for everything below

// 3. Start, and wait on desired_state. Without this, the next step is a 409.
await zc.startAgent(agentId)
await zc.waitUntilRunning(agentId)

// 4. A session per conversation; the first message rides along with the create.
const session = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: 'What is our refund window?' }],
})

// 5. Stream until the turn ends. The stream is session-scoped and does NOT close at turn end -
//    break yourself or you block until the server's idle timeout.
let reply = ''
let lastSeq = 0
for await (const ev of zc.streamEvents(agentId, session.session_id)) {
  lastSeq = ev.seq
  reply += assistantText(ev) // '' for every event that is not agent.assistant
  if (isRunFinished(ev)) {
    if (runOutcome(ev) !== 'succeeded') throw new Error(`run ${runOutcome(ev)}`)
    break
  }
}
```

Later turns in the same session post onto it and stream again from where you stopped:

```ts
await zc.postEvents(agentId, session.session_id, [{ type: 'user.message', content: 'And for annual plans?' }])

for await (const ev of zc.streamEvents(agentId, session.session_id, { after: lastSeq })) {
  lastSeq = ev.seq
  reply += assistantText(ev)
  if (isRunFinished(ev)) break // required every time: the stream does not end on its own
}
```

---

## Events (quick reference)

Enough to write a correct read loop; `references/events-and-streaming.md` has the vocabulary, the
history-reading path, and the reconnect pattern.

- **Read events through the helpers, not by hand.** The same event arrives in two different shapes -
  REST gives `event_type` / `run_id` / `created_at`, SSE gives `eventType` / `runId` / `createdAt` -
  and neither carries a top-level `type`. Everything the SDK returns is already normalized to
  `{ seq, eventType, payload, runId?, turn?, createdAt? }`. Use `assistantText`, `thinkingText`,
  `toolCall`, `isRunFinished`, `runOutcome` rather than reaching into `payload` yourself.
- **`seq` is a durable per-session cursor.** Remember the last one you saw. Reconnect with
  `streamEvents(agentId, sessionId, { after: lastSeq })` and the server replays from your cursor, so
  nothing is lost; it may re-send the boundary frame, and the generator drops that for you.
  **The SDK does not reconnect for you** - it opens one request
  and the generator ends when the server closes on idle. Looping over that is the caller's job.
- **A run can succeed with failed tool calls.** `toolCall(ev).isError === true` does not fail the
  run. Only `runOutcome(ev)` decides.
- **`toolCall(ev).phase` has three values**, not two: `start`, `end`, and `blocked`. A `blocked` call
  is waiting on an approval and has **not** run. Treating it as `end` reports work that never
  happened.
- **`listEvents()` truncates silently.** One page, default 100, hard cap 500, and no `has_more`,
  no total, no cursor in the response. A 600-event session returns 500 and looks complete. Use
  `listAllEvents()` for history unless you are paging by hand.

## Writing into a session

Only four event types can be written: `user.message`, `user.interrupt`, `user.tool_confirmation`,
and `system.message`.

`system.message` is worth knowing about - it injects context the model reads on its next turn
without appearing as a user turn. It is the supported way to hand an agent state your own
application owns (the current user's plan, what they just clicked) since there is no memory resource
to write to.

`user.interrupt` cancels an in-flight run. With no run in flight it answers `accepted: false`, which
is a normal reply and not an error.

## Skills (quick reference)

A ZooClaw skill is a capability attached to an **agent** - a `SKILL.md` plus its files, synced into
the agent's sandbox and read by the model when it judges the skill relevant. There is no
session-level skill list and no API to invoke one; attaching it changes what the agent knows, not
what you can call.

Two things surprise everyone:

- **A brand-new agent already has the global catalog attached** (document skills like `docx`,
  `pptx`, `xlsx`, `pdf` among them). You do not install those, and `putAgentSkill()` against a
  `global` entry answers **404** - it is already attached, you just cannot control it. Do not retry
  that 404 and do not write a provisioning step that installs what it found in the catalog.
- **The zip's top-level directory name must equal the `name` in `SKILL.md`'s frontmatter.** This is
  the single most common first failure. `uploadSkill()` takes the zip plus a required
  `{ scope: 'org' | 'personal' }`; `global` is refused on upload.

Uploading a local skill directory and attaching it is the core of
`references/deploy-your-agent.md` - read it when the user has skills of their own.

---

## Reading guide

| The user wants to | Read |
|---|---|
| A signature, a return shape, or a method you are not certain exists | `references/typescript-sdk.md` - all 44 client methods by area |
| Cron schedules, running a command in the sandbox (`exec`), `wake`, environments, or approvals | `references/typescript-sdk.md` - these surfaces appear **nowhere else in this skill**, and each has a trap worth a debugging session (schedule reads and writes speak different vocabularies; `exec` needs an agent-scope sandbox) |
| To consume the stream, read history, reconnect, or render tool calls | `references/events-and-streaming.md` |
| To host an agent they built locally, with its skills | `references/deploy-your-agent.md` - **follow it in order, do not summarize it** |
| Something you suspect is not supported (custom tools, vaults, webhooks, file uploads, approvals, memory) | `references/not-supported.md` - **read before designing**, each entry names the real alternative |

For anything none of those cover, the SDK's shipped `dist/index.d.ts` is the authority, and the
developer documentation is at `https://github.com/SerendipityOneInc/zoowork-agents-docs`. Prefer
either over recalling a shape.

## Common pitfalls

- **Do not poll `actual_state`.** It reports chat-channel health, `running` is not one of its
  values, and an API-only agent parks at `activating` forever - a loop watching it never returns.
  `waitUntilRunning()` polls `desired_state` and throws `408`/`'timeout'` on a spent budget.
- **There is no custom tool type and no tool-result event.** The agent cannot call back into your
  process mid-turn. `references/not-supported.md` - Client-executed custom tools has the two real
  alternatives (a remote MCP server, or doing the work between turns).
- **`putCredential()` / `listCredentials()` are dead for API-key callers.** Both are `@deprecated`
  and answer 404 through the gateway; the platform seeds model credentials itself, and there is no
  store for your end users' secrets.
- **An Environment choice locks permanently** on first sandbox creation. `stopAgent()` does not
  release it, and a later change answers `409 environment_locked`. Decide before the agent's first
  turn or not at all.
- **`createAgent` and `getAgent` return different shapes.** Create hands back a flat receipt with a
  top-level `config_version`; reads return a projection with the config under `declared` and the
  version at `status.config_version`. Reading the wrong one yields `undefined`, and `undefined ===
  undefined` makes a no-op check pass when it should not.
- **`config_version` is not an optimistic-concurrency token.** Every `PUT` bumps it, including one
  that changes nothing, and so does attaching or detaching a skill. A version that moved does not
  tell you your own section changed, so drift detection built on it does not work.
- **Match errors on `ZooclawError.status` and `.type`, never on the message.** There are two error
  vocabularies, because there are two envelopes: the sessions family answers bare codes
  (`agent_not_running`, `session_archived`), the agents family answers dotted ones
  (`service_api.not_found`). Both land on the same class. No error-code constants are exported -
  compare string literals, and prefer `status` when you only need the class of failure.
- **A cross-tenant or unknown id is `404`, not `403`.** So a 404 does not mean deleted. Keep your own
  record of the ids you create.
- **`deleteAgent()` does not clean up after itself.** It leaves the agent's schedules in place and
  they keep firing. Stop the agent, delete its schedules yourself, then delete it.
- **`exec(agentId, args)` takes argv, not a shell string.** Use `['bash', '-lc', 'ls /workspace']`
  for shell semantics. A non-zero exit is still HTTP 200 - the promise resolves, so check
  `exit_code` yourself.
- **`@zooclaw-agents/sdk` is TypeScript only.** No Python package is published. For another
  language, call the REST API directly and normalize the two event spellings yourself - say that
  rather than inventing an import.
