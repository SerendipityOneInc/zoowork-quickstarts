# ZooClaw Managed Agents - Capability Boundary

Read this before you design, not after the first integration test. Every entry below is something
people routinely build on other agent platforms, and each one changes the shape of a product if you
discover it late. Each entry says what you would build, what actually happens if you try, and the
nearest thing that works.

**"The SDK has no method for it" and "it does not exist" are different claims, and mixing them up
misleads in both directions.** Before you tell a user something is missing, check
`references/typescript-sdk.md` for the method list, or the shipped `dist/index.d.ts`. As of SDK
0.0.5 the client already exposes approvals (`listApprovals`, `resolveApproval`), all seven schedule
methods, six environment methods, `archiveSession` and `deleteSession`, `uploadSkill` /
`uploadSkillVersion` / `listSkills` / `deleteSkill`, `listAgents`, `listSessions`, `exec` and
`wake`. Those are on the client. Whether each one is safe to build on is a separate question, and
this file answers it wherever the recorded evidence says do not build on it.

---

## Client-executed custom tools

**What you would build.** Declare a tool with a JSON schema, let the model decide to call it, run
the function in your own process against your own database, and hand the result back so the same
turn continues with it.

**What actually happens.** There is no custom tool type on `AgentResource`, and there is no
write-side event that carries a tool result. The write side takes exactly four event types:
`user.message`, `user.interrupt`, `user.tool_confirmation`, `system.message`. `OutboundEvent.type`
is typed `string`, so an invented type such as `user.custom_tool_result` compiles cleanly - it just
has no handler, no reader, and no path to the model. The per-event `accepted` flag in the
`postEvents` response is the only signal you get back, so do not expect a thrown error to tell you
that you invented an event type.

**This is structural, not a roadmap gap.** A run is a closed decision path: the tool call is chosen
and recorded before the sandbox executes anything, so handing execution back to your process would
park a committed run on an external HTTP wait, holding its turn budget. Do not tell a user it is
coming.

**What to do instead - option 1: wrap your service as a remote HTTP MCP server.** This is real and
has been exercised end to end for public, unauthenticated servers: the tools appear in the model's
manifest as `mcp__<server>__<tool>` and really execute.

```ts
await zc.createAgent({
  resource: {
    name: 'support-agent',
    model: { primary: 'litellm/claude-sonnet-5' },
    mcp: [{ name: 'orders', url: 'https://mcp.example.com/mcp', transport: 'streamable-http' }],
    //      ^ no underscore: tool names are `mcp__<server>__<tool>`, so an underscore in the
    //        server name makes the split ambiguous and the server is rejected
  },
  ownership: { owner_uid: 'placeholder', org_id: 'placeholder' },
})
```

`mcp` is an agent-level declared section, so `updateAgent(agentId, { mcp: [...] })` changes it
later. Remote HTTP only - `streamable-http` (the default) or `sse`; there is no stdio transport and
no OAuth. The URL must be publicly reachable: loopback, private ranges, cloud metadata addresses
and redirects are all refused. A server that fails its catalog probe does not fail the run; it pins
an empty catalog and emits an `agent.error` event with `kind: 'mcp_connection_failed'`, so a
silently tool-less agent is the failure mode to watch for.

The real limit is identity. `McpServerDeclaration.credential` names a slug for a single static
bearer token, and the endpoint that would store the secret behind that slug answers 404 through the
gateway by design - so **authenticated MCP is not usable**. The declared credential is one shared
value for the whole agent in any case, so every end user's request arrives at your server with the
same identity. If your product needs to act as the signed-in user, this option cannot get you
there.

**What to do instead - option 2: keep the decision in your own process.** Let the turn finish, do
the work yourself, and post the answer as the next message. It costs one extra turn and it is
entirely inside the verified surface.

```ts
const s = await zc.createSession(agentId, {
  initial_events: [{ type: 'user.message', content: 'Where is my order? Ask with ORDER_LOOKUP(<id>) if you need data.' }],
})

let reply = ''
let lastSeq = 0
for await (const ev of zc.streamEvents(agentId, s.session_id)) {
  lastSeq = ev.seq
  reply += assistantText(ev)
  if (isRunFinished(ev)) break // the stream does NOT close at turn end - break or you wait for the idle timeout
}

const ask = /ORDER_LOOKUP\(([^)]+)\)/.exec(reply)
if (ask) {
  const order = await myDatabase.findOrder(ask[1]) // your code, your credentials, your process
  await zc.postEvents(agentId, s.session_id, [
    // system.message carries its body in `text`. `content` is the user.message field, and the
    // open OutboundEvent type will not catch the mix-up for you.
    { type: 'system.message', text: `Order lookup result: ${JSON.stringify(order)}` },
    { type: 'user.message', content: 'Answer the customer using that data.' }, // system.message alone does not start a turn
  ])
  let answer = ''
  for await (const ev of zc.streamEvents(agentId, s.session_id, { after: lastSeq })) {
    lastSeq = ev.seq
    answer += assistantText(ev) // resumed from lastSeq: no gap, no duplicate frame
    if (isRunFinished(ev)) break
  }
}
```

`system.message` injects context the model reads on its next turn without appearing as a user turn,
which keeps your injected data out of the visible conversation. It does not start a turn on its
own, so pair it with a `user.message` when you need an answer now.

---

## End-user credential storage

**What you would build.** A vault per end user holding their third-party tokens, so the agent acts
as that user against their calendar, their repo, their CRM.

**What actually happens.** There is no vault resource of any kind. `putCredential()` and
`listCredentials()` are still on the client interface, both marked `@deprecated`, and both answer
404 through the gateway: the gateway owns the credential layer and seeds model credentials itself.
`McpServerDeclaration.credential` accepts a slug and stores it on the agent, but the slug points at
a store you cannot write to.

**Why.** Your `zct_` key authenticates an entire organization. There is no end-user principal
anywhere in this API for a secret to be scoped to, so there is nothing for a vault to key on.

**What to do instead.** Keep end-user secrets in your own backend and never let them cross into the
platform. Make the calls that need them from your own process and pass results in as messages, as
in option 2 above. Do not smuggle a secret into an agent's persona docs, a skill file, or session
`metadata`: persona and skills are agent-wide and shared by every session, and any holder of the
organization key can read them back.

---

## Session file attachment and repository mounting

**What you would build.** Attach a PDF or a CSV to a session and ask about it; mount a git
repository into the workspace so the agent can read the code.

**What actually happens.** `createSession(agentId, input)` accepts exactly two fields:
`initial_events` and `metadata`. There is no `resources[]`, no `mount_path`, no
`github_repository`, no upload endpoint on a session. The client exposes no file or artifact route
at all, and no such route has been exercised against a live deployment, so treat fetching bytes
back out as unavailable rather than assuming a path exists. `attachment.created` does exist in the
event vocabulary, so you may observe one, but the SDK offers nothing that fetches what it refers
to.

**What to do instead.** For anything text-sized, put the content in the conversation: a
`user.message` with the text, or a `system.message` when it is reference material rather than
something the user said. For files the agent must find on disk in every session, bake them into an
Environment - `config.files[]` takes `{ path, contentBase64, executable }` and the files land under
`/opt/zooclaw/environment/`. That is build-time and shared by every session of every agent pinned
to it, which fits reference data and fits nothing per-user. For an agent-scope sandbox,
`exec(agentId, ['bash', '-lc', '...'])` runs commands in `/workspace` and can place files there,
but it is an operations side door: it is agent-wide, not per session, and a session-scope agent
answers `409 exec_requires_agent_scope`.

For a repository, the only theoretical route is having the agent clone it with bash inside its own
sandbox. Nobody has verified it, and for a private repository it runs straight into the credential
problem above. Treat it as an experiment to run, not a recipe to hand over.

---

## Outcome definitions and rubric grading

**What you would build.** Declare acceptance criteria on the session, let the agent iterate until
it meets them, and read a grade off the result. On other platforms this is a `define_outcome` event
plus a grader.

**What actually happens.** Neither half exists. `define_outcome` is not one of the four write-side
event types, so `initial_events` will not carry it; there is no rubric field, no grader, and no
score in any event payload. The whole category of "iterate until it passes" and "automatically
scored agent eval harness" has no platform support.

**What to do instead.** Grade in your own process, where you can also version the rubric. You have
the material: `listAllEvents(agentId, sessionId)` returns every durable event without the silent
500-event truncation that `listEvents` has, and `getSession(agentId, sessionId, { history: true })`
returns the at-rest transcript, which is the one surface that also carries token usage and the
model that actually served the turn. Run your own judge over that, and post another `user.message`
when the answer falls short. Each iteration is one turn, and the loop lives in your code.

---

## End-to-end human approval

**Be precise here, because the pieces exist and the loop does not.** Present separately: an
`agent.approval` event type; `agent.tool` events with `phase: 'blocked'`, meaning the call is
parked and has **not** run; a write-side `user.tool_confirmation` event; and a REST approvals
resource with `listApprovals(agentId, { status: 'pending' })` and `resolveApproval(agentId,
approvalId, { decision })` where `decision` is one of `allow-once`, `allow-always`, `deny`.

**What actually happens.** The loop has never been observed to close. The only observation against
a live deployment is a 200 with an empty `approvals` array, because producing a real pending
approval needs a tool policy that asks for one - so `ApprovalRecord`'s field names are unverified
and should be read defensively. Where no signaler is configured the route answers
`501 not_configured`. `status` may only be omitted or `'pending'`, so resolved approvals cannot be
listed at all. And the REST shape and the event shape do not line up: approvals are a resource,
`user.tool_confirmation` is an event, they describe the same act in two vocabularies, and no
mapping between them has been demonstrated. Meanwhile a run parked on an approval sits there
spending its turn budget waiting.

**Do not build on it.** If a user needs human review, put the wait in your own product: let the
turn finish, show the proposed action to your reviewer, and post the approved instruction as the
next `user.message`. That keeps a human-length delay outside a run that is being charged for
waiting.

---

## Listing sessions across agents

**What you would build.** One inbox: every session belonging to every agent you own, newest first,
one call.

**What actually happens.** There is no top-level sessions collection. `listSessions(agentId,
{ page })` is per agent, newest first by `updated_at`, 50 rows per page, `page` is 1-based, and the
response carries no cursor.

**What to do instead.** Fan out over `listAgents()` and call `listSessions` per agent - but know
the trap before you rely on it: `listAgents` is scoped to your key's bound user *and* your
organization, so an agent a colleague created in the same organization is fetchable by `getAgent`
if you know its id but never appears in the list. A fan-out built on `listAgents` silently misses
those. The durable answer is to keep your own index of agent ids and session ids in your own
database, keyed by your own user id. You need that index anyway: the platform has no notion of your
end users, so attributing a session to one is only possible on your side.

---

## A memory store resource

**What you would build.** A store you write facts into and the agent reads across sessions, with
CRUD and versioning of its own.

**What actually happens.** There is no memory resource in the API: nothing to create, nothing to
mount, nothing to version, nothing to read. Separately, the model may or may not have engine-side
memory tools available to it depending on how a deployment is configured, and the API does not
report which - so an agent may appear to remember things in one deployment and not another. Do not
design around behavior you cannot query or control.

**What to do instead.** Your database is the memory, and there are two supported ways to get it in
front of the model. Per turn: `system.message`, which injects state your application owns (the
user's plan, what they just clicked) without appearing as a user turn. Per agent:
persona docs, for facts that are the same for everyone - but note `updateAgent` bumps
`config_version` on every call including a no-op, so rewriting the persona per turn churns the
agent's version forever. Within a conversation, keep one session: the transcript is the context,
and a new session starts blank.

---

## Platform signed webhooks

**What you would build.** Register a callback URL, receive a signed POST when a run finishes, and
run no long-lived process of your own.

**What actually happens.** There is no webhook registration resource. The one place delivery is
configurable at all is a schedule's `delivery` field, which accepts `none` or a typed `announce`;
webhook delivery is refused there.

**What to do instead.** Every durable event carries `seq`, a per-session cursor that survives
disconnects. Hold the stream for a live conversation and, when the server closes it on idle, call
`streamEvents(agentId, sessionId, { after: lastSeq })` again - you resume from exactly there, with
no gap and no duplicate reaching your loop (the server may re-send the boundary frame; the
generator drops it). For a background job, poll
`listAllEvents(agentId, sessionId, { after: lastSeq })` on whatever interval suits you, with the
same guarantee. Webhook consumers usually implement that de-duplication themselves with an
idempotency table; the `seq` cursor supplies it. What you do give up is process-free operation: you
pay for the connection or the poll, and someone has to run the loop.
See `references/events-and-streaming.md` - Reconnecting.

---

## Agent version pinning and rollback

**What you would build.** Pin an agent to a known-good configuration version, ship a prompt change,
and roll back when it regresses.

**What actually happens.** There is no version history route, no pin, and no rollback. Older
configurations are not retrievable through the API. `config_version` is a counter and not a handle
to anything: every `PUT` bumps it including one that changes nothing, and so does attaching or
detaching a skill, so a version that moved does not tell you what changed.

**What to do instead.** Keep the agent configuration in your own source control and treat
`updateAgent` as a deployment: rolling back means re-`PUT`ing the previous configuration from your
repository. Note the asymmetry with skills, which *do* have pinning -
`putAgentSkill(agentId, skillId, { versionPin: 3 })` freezes a skill at a version, and
`versionPin: null` follows the latest. So an agent's prompt has no versioning while its skills do.

---

## Self-hosted tool execution

**What you would build.** Run the sandbox on your own machines - your worker pool, your network,
your data never leaving it - while the platform still drives the agent loop.

**What actually happens.** Nothing exposes it. There is no worker registration, no work queue to
subscribe to, and no environment key that would point execution somewhere else. Environments
customize what is installed inside the platform's sandbox; they do not relocate it.

**What to do instead.** If the goal is reaching a private system, run a public MCP endpoint at the
edge of your network - which must be safe to expose unauthenticated, per the first entry - or keep
that work in your own process entirely and pass results in as messages. If the goal is
controlling egress, note that a sandbox's default network policy is `unrestricted`; an Environment
with `networking: { type: 'limited', allowed_hosts: [...] }` is the way to narrow it, and it is a
create-time decision because the Environment pin freezes on first sandbox creation.

---

## Smaller absences

| Absent | What you actually see | Nearest thing that works |
|---|---|---|
| A CLI | The package ships a library only; there is no executable | Every operation is a client method, or a raw HTTP call to the same routes |
| `agent_with_overrides` on session create | `createSession` accepts `initial_events` and `metadata`, nothing else | `updateAgent` (bumps `config_version`), or a second agent for the second configuration |
| Per-session tool or MCP overrides | `tool_policy` and `mcp` are agent-level fields on `AgentResource` | One agent per tool configuration; every session of an agent sees the same set |
| Session `PATCH` | `405 Method Not Allowed`: the gateway proxies GET/POST/PUT/DELETE only, so PATCH is not proxied for any resource | Session `metadata` is write-once at `createSession`; keep mutable per-conversation state in your own store |
| `session.status_*`, `span.*`, `stop_reason` as turn signals | None of them is an event type; `SESSION_EVENT_TYPES` has 19 entries and none of these. (`stopReason` does appear at `payload.message.stopReason` on an `agent.assistant` event, but it describes that one message, not the turn) | A turn ends at `run.finished`; the outcome is `runOutcome(ev)` |
| Working credential methods | `putCredential` / `listCredentials` are `@deprecated` and 404 through the gateway | Nothing. Model credentials are seeded by the platform; your own secrets stay in your process |
| Installing global skills | `listSkills({ scope: 'global' })` lists them; `putAgentSkill` on one answers 404 | Nothing to do: the global catalog is already attached to a new agent. Upload your own with `scope: 'org'` or `'personal'` |
| Rich environment builds | `config` takes exactly `packages` (apt/npm/pip only), `files`, `build`, `networking`; anything else is `400 invalid_environment_config`. No secrets, no runtime env vars, no start hooks | Install through `packages` and `build.script`; fetch anything secret at run time from your own service |
| Schedule pause / unpause / archive | No such routes | `updateSchedule(agentId, scheduleId, { enabled: false })` is the off switch, `deleteSchedule` removes it. The `state.paused` field on list rows is a different thing and is unrelated to `enabled` |
| Schedule cleanup on agent delete | Schedules outlive their agent; `stopAgent` and `deleteAgent` leave them running | `listSchedules` then `deleteSchedule` for each, before `deleteAgent` |
| An artifacts or files REST surface | The client exposes no file or artifact route and none has been exercised; note that an unknown id also answers `404 service_api.not_found`, so a 404 on its own does not prove a route is absent | Move content as text in the conversation, or bake it into an Environment at build time |
| Scoped or read-only API keys | A `zct_` token is not scopeable: it reads and writes every agent in the organization, and this API exposes no scoping or lifetime controls | Keep it server-side only, behind your own authorization layer. Separate organizations are the only hard boundary |
| A documented key rotation flow | Keys are issued and revoked by an organization administrator; there is no documented rotation procedure | Issue the new key, cut over, then have the administrator revoke the old one - and build for the key being a value you can change without a redeploy |

---

## When you are unsure

The SDK's shipped `dist/index.d.ts` carries a JSDoc note on nearly every method recording what was
actually observed against a live deployment, including which routes were never exercised. Prefer it
over anything recalled. When a capability is not mentioned here and not in
`references/typescript-sdk.md`, say that it is unverified rather than guessing an answer in either
direction - a reader who knows they must check is better off than one who trusts a wrong recipe.
