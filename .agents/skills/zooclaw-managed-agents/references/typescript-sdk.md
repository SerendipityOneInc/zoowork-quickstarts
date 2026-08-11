# TypeScript SDK surface

All 44 methods on `ZooclawClient`, grouped by area, signatures exactly as `src/client.ts` declares
them. The package is `@zooclaw-agents/sdk` - ESM only (no CJS `require` condition, no subpath
exports), zero runtime dependencies, `engines.node >= 20`, shipping `dist/index.d.ts`, which is the
authority over anything here. `SKILL.md` has the mandatory flow; this file is for looking up a
signature, a return shape, or whether a method exists.

Twelve runtime values are exported and a test pins the list, so an import outside it fails:
`createZooclawClient`, `DEFAULT_BASE_URL`, `ZooclawError`, `SESSION_EVENT_TYPES`, `normalizeEvent`,
`isRunFinished`, `runOutcome`, `messageText`, `assistantText`, `thinkingText`, `toolCall`,
`parseSSE`. Everything else is a `type`, and there are no error-code constants - see Errors.

## Client construction

```ts
createZooclawClient(cfg: ZooclawConfig = {}): ZooclawClient   // cfg itself is optional

interface ZooclawConfig {
  apiKey?: string    // falls back to ZOOCLAW_API_KEY; an empty ENV VAR counts as unset, an explicit apiKey: '' does not
  baseUrl?: string   // falls back to ZOOCLAW_BASE_URL, then DEFAULT_BASE_URL; trailing slashes stripped
  auth?: ZooclawAuth // { serviceToken } is deployment-internal, not available to API-key callers
  fetch?: (input: string, init?: RequestInit) => Promise<Response>  // for edge runtimes and tests
}

export type ZooclawAuth = { serviceToken: string } | { apiKey: string }
export const DEFAULT_BASE_URL = 'https://claw-interface.ecap.yesy.live/service/v1'
```

**The SDK reads exactly two environment variables: `ZOOCLAW_API_KEY` and `ZOOCLAW_BASE_URL`** -
nothing else appears anywhere in the source. There is no `ZOOCLAW_ORG_ID`: the gateway derives the
tenant from the key, so an org id in your environment is dead configuration. Construction **throws a
plain `Error`, not a `ZooclawError`**, when no key resolves - a missing key is a setup mistake, and
failing loudly here beats a 401 on whatever call runs first, but it does mean a `catch` narrowing on
`instanceof ZooclawError` will not match it. That guard tests `cfg.apiKey !== undefined`, not
truthiness, so an explicit `apiKey: ''` - which is what `process.env.KEY ?? ''` hands you - slips
past it and builds a client that sends an empty bearer and 401s on the first call. Only the
environment-variable path maps `''` to unset. `DEFAULT_BASE_URL` already includes the `/service/v1`
version prefix; appending another `/v1` 404s every call. An `Idempotency-Key` header is sent only
when the optional key argument is truthy (`createAgent`, `createSession`, `createSchedule`,
`createEnvironment`, `createEnvironmentVersion`, `uploadSkill`, `uploadSkillVersion`).

## Models

```ts
listModels(): Promise<ModelInfo[]>   // no arguments, no paging
```

Model ids are prefixed, e.g. `litellm/claude-sonnet-5`. Both wire shapes (a bare array or
`{ models }`) are tolerated, so you always get an array.

## Agents

A stored, versioned configuration. Create once, keep the `agent_id`, reference by id forever.

```ts
createAgent(input: { resource: AgentResource; ownership: Ownership }, idempotencyKey?: string): Promise<AgentRecord>
listAgents(opts?: { labels?: Record<string, string>; page?: number }): Promise<AgentRecord[]>
getAgent(agentId: string): Promise<AgentRecord>
updateAgent(agentId: string, sections: Record<string, unknown>): Promise<AgentRecord>  // per-section PUT; bumps config_version on every call
deleteAgent(agentId: string): Promise<void>                     // 204; does NOT remove the agent's schedules - delete those yourself first
startAgent(agentId: string): Promise<{ warnings: string[] }>    // warnings are informational, never a failure
stopAgent(agentId: string): Promise<{ warnings: string[] }>     // does not clear environment_locked, does not remove schedules
waitUntilRunning(agentId: string, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<AgentRecord>
```

`ownership` is required by the schema and then rewritten by the gateway to your key's tenant - send
`{ owner_uid: 'placeholder', org_id: 'placeholder' }` rather than hunting for real ids. **The create
receipt and the read projection are different documents under one `AgentRecord` type:**

| | `createAgent` (receipt) | `getAgent` / `updateAgent` (projection) |
|---|---|---|
| Config version | top-level `config_version` | `status.config_version` |
| Configuration | absent | `declared` |
| Lifecycle | absent | `status.desired_state`, `status.actual_state` |

Read the version across both as `agent.status?.config_version ?? agent.config_version`. One alone is
`undefined` on the other path, and `undefined === undefined` makes a "nothing changed" check pass
when it should not. It is no optimistic-concurrency token either: every PUT bumps it including a
no-op one, and so does attaching or detaching a skill - so a version that moved does not tell you
your own section changed.

**`updateAgent` merges per section.** `sections` is the declared config keyed by section, so sending
only `model` leaves `persona`, `labels`, `mcp` and the rest untouched. Within a section the value is
replaced, not merged, so a partial `persona` drops the docs you left out. `AgentResource.warm` is
**create-only**: it pre-warms the agent-scope sandbox so the first tool call skips the cold start,
is never written to the declared config, and a PUT carrying it is a 400 (under
`sandbox.scope: 'session'` it is ignored, and the receipt carries
`warnings: ['warm-ignored-session-scope']`). The rest of `AgentResource` is optional except
`name: string`:

| Field | Type | Note |
|---|---|---|
| `model` | `{ primary: string; input?: string[] }` | prefixed id from `listModels()` |
| `persona` | `{ docs: { name: string; content: string; seed_policy?: string }[] }` | `docs` is an **array of documents**, not a filename-keyed object |
| `skills` | `{ skill_id: string; version?: number \| 'latest' }[]` | declared on the type, but no recorded create exercised it - attach with `putAgentSkill` instead |
| `labels` | `Record<string, string>` | what `listAgents({ labels })` filters on |
| `tool_policy` | `Record<string, unknown>` | reads back as `{}` in the declared config; no key names are pinned by any recorded response, so omit it |
| `mcp` | `McpServerDeclaration[]` | remote HTTP only; the server `name` must contain no underscore |
| `sandbox` | `{ scope: 'agent' \| 'session' }` | `exec` needs `agent` |
| `environment_id`, `environment_version` | `string`, `number` | pins permanently on first sandbox creation |
| `onboarding` | `boolean` | set `false` for API-driven agents, or the first turn is an interview |

**`listAgents` scope is `owner_uid` AND `org_id`**, both injected from your key, so an agent a
colleague created in the same org is fetchable by `getAgent(id)` and never appears in the list. An
empty list is therefore not proof the agent does not exist, and a provisioning path reasoning "not
in the list, therefore create one" mints duplicates alongside it. `labels` filters on declared
labels, sent as `label.<key>=<value>` parameters - the way to resolve your own external id back to
an agent. Page size is fixed at 100 by the engine.

**`waitUntilRunning`** defaults to `timeoutMs = 30_000`, `intervalMs = 500`, polls `getAgent`, and
returns that `AgentRecord` once `status.desired_state === 'running'`. Both failures are
**synthesized locally - the server never sends either**, which matters to any retry policy that
treats server 408s specially: a spent budget throws `408` with `type: 'timeout'`, an aborted
`signal` throws `0` with `type: 'aborted'`. Both bounds cover an in-flight poll, not just the gap
between polls, which is why this beats a hand-rolled loop - `fetch` imposes no timeout of its own in
any runtime the SDK targets, so a stalled gateway parks such a loop forever. The other reason is
`actual_state`: it reports chat-channel health, `running` is not one of its values, and an API-only
agent sits at `activating` permanently.

## Sessions

One conversation. Every session method takes `agentId` first, because the route is
`/agents/{id}/sessions/...` and there is no session handle that hides it.

```ts
createSession(
  agentId: string,
  input: { initial_events?: OutboundEvent[]; metadata?: Record<string, unknown> },  // input is required, both fields optional
                                                                                    // initial_events: only ONE user.message has been sent here - the type is wider than what is verified
  idempotencyKey?: string,
): Promise<SessionRecord>                                                          // 409 agent_not_running unless desired_state is running
getSession(agentId: string, sessionId: string, opts?: { history?: boolean; limit?: number }): Promise<SessionRecord>
listSessions(agentId: string, opts?: { page?: number }): Promise<SessionRecord[]>  // newest first, 50 per page, 1-based, no cursor
archiveSession(agentId: string, sessionId: string): Promise<{ session_id?: string; archived: boolean }>
deleteSession(agentId: string, sessionId: string): Promise<void>   // soft delete; cancels an in-flight run, keeps the transcript
```

**There is no `patchSession`, on purpose.** `PATCH` is not proxied by the gateway at all (its
catch-all registers GET/POST/PUT/DELETE), so it answers 405. Session `metadata` is write-once, at
`createSession`; mutable per-conversation state belongs in your own store keyed by `session_id`. The
run outcome is `run_status`, and it is on **both** surfaces - `listSessions` rows and `getSession`
alike, so a read already has it and needs no second call. The decoy is `status`: `null` on
`getSession`, absent from list rows entirely, and carrying `running` only on the `createSession`
receipt. Asking for `history: true` populates `history?: SessionHistoryEntry[]`, the at-rest
transcript rather than the event log - text is at `entry.message` (`{ role, content }`) on rows
whose `entry_type` is
`message`. `archiveSession` flips `archived` to `true` (the receipt is `{ session_id, archived }`,
and a later read still answers `archived: true`); afterwards writes answer `409 session_archived`
while reads keep working, so interrupt an in-flight run first or the archive races it.

## Events

`references/events-and-streaming.md` - Reading a turn covers the helpers and the reconnect loop.

```ts
postEvents(agentId: string, sessionId: string, events: OutboundEvent[]): Promise<{ events: { id?: string; type?: string; accepted?: boolean }[] }>
listEvents(agentId: string, sessionId: string, opts?: { after?: number; types?: string[]; limit?: number }): Promise<SessionEvent[]>
listAllEvents(
  agentId: string,
  sessionId: string,
  opts?: { after?: number; types?: string[]; pageSize?: number },
): Promise<SessionEvent[]>
streamEvents(agentId: string, sessionId: string, opts?: { after?: number; signal?: AbortSignal }): AsyncGenerator<SessionEvent>  // a generator, not a promise
```

Only four `OutboundEvent` types can be written: `user.message`, `user.interrupt`,
`user.tool_confirmation`, `system.message`. `postEvents` answers 202; a `user.interrupt` with no run
in flight comes back `accepted: false`, a normal reply rather than an error. **`listEvents` returns
one page and truncates silently.** `limit` defaults to 100 and caps at 500, and the response carries
no `has_more`, no total and no next cursor - a session with 600 events answers 500 and looks
complete, with nothing on the result distinguishing a full page from the end of the log.
`listAllEvents` walks the same endpoint on the **`after` sequence cursor**, not a page number:
`pageSize` is the per-request `limit` (default and maximum 500), each round advances `after` to the
highest `seq` seen, and the walk stops on a short page or when that `seq` fails to advance the
cursor, so a server ignoring `after` returns a duplicate page rather than spinning forever. Results
are ascending by `seq`, deduplicated across page boundaries.

`streamEvents` opens exactly one request and yields until the body ends. It does **not** reconnect,
retry or back off; when the server closes on idle the generator returns, and resuming is your loop
calling it again with `{ after: lastSeq }`. A non-2xx response throws a `ZooclawError` with no
`type`; an abort via `opts.signal` ends the generator cleanly rather than throwing.

## Skills

Two families: the **registry** owns skill packages org-wide, the **per-agent** methods attach one to
an agent. Attaching changes what the agent knows; there is no API to invoke a skill.

```ts
// registry
uploadSkill(
  zip: Blob | ArrayBuffer | Uint8Array,
  opts: { scope: 'org' | 'personal'; fileName?: string; description?: string; idempotencyKey?: string },  // opts is REQUIRED: scope is mandatory
): Promise<SkillRecord>
uploadSkillVersion(
  skillId: string,
  zip: Blob | ArrayBuffer | Uint8Array,
  opts?: { fileName?: string; description?: string; idempotencyKey?: string },
): Promise<SkillRecord>
listSkills(opts?: { scope?: 'org' | 'personal' | 'global' | string; q?: string; page?: number }): Promise<SkillRecord[]>
deleteSkill(skillId: string): Promise<void>   // 204, no in-use guard: agents holding it just lose it

// per agent
listAgentSkills(agentId: string, opts?: { verbose?: boolean }): Promise<AgentSkill[]>  // verbose includes ineligible/excluded entries
putAgentSkill(agentId: string, skillId: string, opts?: { enabled?: boolean; versionPin?: number | null }): Promise<{ config_version?: number; warnings?: string[] }>
deleteAgentSkill(agentId: string, skillId: string): Promise<void>
```

`uploadSkill`'s `opts` is not optional because `scope` is mandatory, and it may only be `org` or
`personal` - `global` and `pack` answer 403, published through an admin surface the gateway does not
proxy. This is the only path by which an API-key caller adds a skill an agent will load. **The zip's
single top-level directory name must equal the `name` in `SKILL.md`'s frontmatter** (compared case-
and underscore-insensitively), or the upload is a 400 reading like
`top-level directory 'my-test-skill' must match SKILL.md name 'market-research'`. So
`zip -r skill.zip market-research/` where `market-research/SKILL.md` declares
`name: market-research`; a zip whose root is the skill (`SKILL.md` at the top) is also accepted.
`SKILL.md` must be non-empty and declare both `name` and `description`. Limits: 50 MB expanded, zip
only, encrypted zips rejected.

`uploadSkillVersion` adds a version to an existing skill; the frontmatter `name` must match that
skill's name, and `description` overrides the frontmatter one. **Agents that installed the skill
unpinned follow the new version on their own** - the registry bumps their `config_version` - so a
redeploy is one upload, not an upload plus a `putAgentSkill` sweep. Only an agent pinned with
`versionPin` stays behind. `putAgentSkill` sends
`{ enabled: opts.enabled ?? true, version_pin: opts.versionPin ?? null }`, so camelCase `versionPin`
becomes snake_case on the wire and omitting `opts` means enabled and unpinned. Only skills your
tenant owns are installable: a `global` catalog entry lists fine and answers **404** here, not worth
retrying - a fresh agent already has the global catalog attached, you simply cannot control those
entries. `SkillRecord.latest_version` came back as the string `"1"` from the multipart create while
other surfaces spell it as a number; compare loosely.

## Exec and wake

```ts
exec(agentId: string, args: string[]): Promise<ExecResult>   // args is argv, NOT a shell string
wake(agentId: string, input: { text: string; mode?: 'now' | 'next-heartbeat'; deliverToUser?: boolean }): Promise<WakeResult>

interface ExecResult { exit_code: number; stdout: string; stderr: string }   // non-zero exit is still HTTP 200
interface WakeResult { mode: 'now' | 'next-heartbeat' | string; queued: boolean; triggered: boolean }
```

`exec(id, ['ls /workspace'])` looks for a binary literally named `ls /workspace`; for shell
semantics pass `['bash', '-lc', 'ls /workspace']`. **A non-zero exit is still HTTP 200** - the
promise resolves and you check `exit_code` yourself; it rejects when the call fails, not when the
command does. `cwd` is fixed to `/workspace` with no option to change it, so use absolute paths or
`cd` inside a `bash -lc` string. It requires an agent-scope sandbox and a rendered config: a
session-scope agent answers `409 exec_requires_agent_scope`, an unrendered one
`409 exec_config_not_ready`, a deployment with no sandbox backend `501 not_configured`. Default
timeout 300s; `stdout` and `stderr` are each capped at 200,000 characters. `wake` pushes a reminder
into the heartbeat queue. `next-heartbeat`, the default, only writes the pending row - nothing
consumes it unless the agent has a heartbeat configured, so on an agent without one it succeeds and
does nothing. `now` writes the row and kicks the heartbeat schedule, and is 409 when no heartbeat is
enabled; if the heartbeat is busy the kick is skipped and the row waits for the next one.
`deliverToUser: false` keeps the reminder internal to the agent's reasoning.

## Schedules

Cron-driven turns, where the read shape and the write shape are different documents.

```ts
listSchedules(agentId: string): Promise<ScheduleRecord[]>              // no opts, no paging
createSchedule(agentId: string, input: ScheduleInput, idempotencyKey?: string): Promise<ScheduleRecord>
getSchedule(agentId: string, scheduleId: string): Promise<ScheduleRecord>   // the SHORT id you chose, not record.scheduleId
updateSchedule(agentId: string, scheduleId: string, update: ScheduleUpdate): Promise<ScheduleRecord>
deleteSchedule(agentId: string, scheduleId: string): Promise<void>
triggerSchedule(agentId: string, scheduleId: string): Promise<{ schedule_name?: string; triggered: boolean }>
listScheduleRuns(agentId: string, scheduleId: string, opts?: { limit?: number }): Promise<ScheduleRun[]>  // rows GROUPED BY source, not time-sorted; limit defaults 20, caps at 100
```

**Which id to pass.** `ScheduleRecord.scheduleId` is the fully-qualified
`cron/{computer_id}/{agent_id}/{schedule_id}`; the id you chose comes back as `name` on
`getSchedule` **only**. A list row carries no `name` key at all - it puts your id at
`memo.schedule_id`, and its `schedule_name` is that same fully-qualified string, not the short one.
Every method above wants the short one - `record.scheduleId` builds a path with slashes in it and
404s. **And three responses use three vocabularies:** `createSchedule`
answers a snake_case receipt carrying only `schedule_name`, not the definition; `getSchedule`
answers a camelCase projection; `listSchedules` answers the raw scheduler describe (`spec` / `state`
/ `memo` / `next_action_times`) with that projection merged on top. Nothing comes back under the
name you sent it: the cadence you wrote as `schedule` reads back as
`scheduleSpec: { timezoneName, catchupWindowMs, cronExpressions[] }`, and
`sessionTarget: 'isolated'` as `execution: { kind: 'isolated' }`.

**A `getSchedule` result is not a legal PUT body.** `updateSchedule` discards six fields before
sending, and all six are fields a read hands you:

| Field | What the server does with it |
|---|---|
| `execution`, `originMetadata`, `contextSnapshot`, `creatorPrincipalRef` | 400, server-derived |
| `sessionTarget` | 400, immutable |
| `scheduleSpec` | **200, then silently ignored** |

All six are typed `never` in `ScheduleUpdate` so TypeScript refuses them, and the SDK strips them at
runtime so the same read-tweak-write round trip works from JavaScript too. The last row is the
expensive one: `scheduleSpec` is the only place a read puts the cadence, so echoing it back answers
200 while leaving the old cron expression in place, and every sibling field in the body applies -
the update looks like it worked. **To change the cadence send `schedule`, the input vocabulary.**
`ScheduleSpec` has three kinds (`cron`, `every`, `at`) and only `cron` has its field names pinned by
the engine reference. Cron is five fields; macros and a `CRON_TZ=` prefix are rejected, and overlap
is fixed to skip server-side, so a fire landing on a still-running one is dropped, not queued.

`createSchedule` is 409 when you re-create an existing `schedule_id` with a **different**
definition; an identical retry is accepted. PUT and DELETE carry no cross-timeout idempotency
guarantee - after a timeout, reconcile by listing and reading runs rather than blind-retrying.
**Schedules outlive their agent**: neither `stopAgent` nor `deleteAgent` removes them, so delete
them yourself first or they keep firing against a deleted agent. `triggerSchedule` returns
`triggered: true` even for a **disabled** schedule, while the run projection records
`status: "skipped"`. `triggered` means the fire was dispatched; it never means the turn ran, so read
`listScheduleRuns`. Those rows mix two shapes discriminated by `source`: `temporal` rows are
dispatch records (`scheduled_at` / `taken_at` / `workflow_id` / `temporal_run_id`) saying nothing
about the outcome, `run_projection` rows are outcome records (`fired_at` / `status` /
`consecutive_errors`). Neither carries `session_id`, so you cannot walk from a fire to the session
it created - list the agent's sessions and match `channel: 'cron'` against the `session_key` prefix
`agent:{agent_id}:cron:{schedule_id}:`.

## Approvals

```ts
listApprovals(agentId: string, opts?: { status?: 'pending' }): Promise<ApprovalRecord[]>  // 'pending' or omitted; any other value is rejected
resolveApproval(
  agentId: string,
  approvalId: string,
  input: { decision: ApprovalDecision; resolvedBy?: string },
): Promise<Record<string, unknown>>

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'
```

Because `status` may only be omitted or `'pending'`, resolved approvals cannot be listed - record
decisions yourself if you need an audit trail. Where no approval signaler is configured the route
answers `501 not_configured`, a deployment property your code cannot fix. Two shapes describe the
same act and do not line up - this REST resource, and the `user.tool_confirmation` event you write
with `postEvents`. They are not two views of one object, so do not correlate an `approval_id` with a
tool-call id. **The loop has never been closed end to end:** the only observation is a 200 with an
empty `approvals` array, so `ApprovalRecord`'s field names are unverified. Do not build on it, and
note that a run parked on an approval burns its whole turn budget waiting. The reasoning, and what
to do instead, is in `references/not-supported.md` - Approvals.

## Environments

A versioned sandbox image. Optional - a fresh agent is already pinned to a platform default - and
the pin locks permanently on first sandbox creation.

```ts
listEnvironments(opts?: { page?: number }): Promise<EnvironmentRecord[]>   // 1-based; the platform default is not in here
getEnvironment(environmentId: string): Promise<EnvironmentRecord>          // 404 outside your org, incl. the platform default
createEnvironment(
  input: { resource: EnvironmentResource; ownership: Ownership },
  idempotencyKey?: string,
): Promise<EnvironmentRecord>
archiveEnvironment(environmentId: string): Promise<EnvironmentRecord>
createEnvironmentVersion(
  environmentId: string,
  config: EnvironmentConfig,     // a bare config; the SDK wraps it as { resource: { config } }
  idempotencyKey?: string,
): Promise<EnvironmentVersionRecord>
getEnvironmentVersion(environmentId: string, version: number): Promise<EnvironmentVersionRecord>

// resource.config accepts EXACTLY these four keys; anything else is 400 invalid_environment_config,
// which is why EnvironmentConfig has no index signature and a stray key is a compile error.
interface EnvironmentConfig {
  packages?: { apt?: string[]; npm?: string[]; pip?: string[] }   // install order is fixed apt -> npm -> pip
  files?: { path?: string; contentBase64?: string; upload_id?: string; executable?: boolean }[]
  build?: { script?: string; verify_script?: string }
  networking?: { type: 'unrestricted' | 'limited'; allowed_hosts?: string[] }  // omitted means unrestricted
}
```

Files land under `/opt/zooclaw/environment/`, and a top-level `bin/*` marked executable is linked
into `/usr/local/bin`. No secrets, no runtime env vars, no start hooks. **Poll
`getEnvironmentVersion` and read `status`, not `state`**: there is no `state` field on a version, so
a loop written against one compares `undefined` to `'ready'` forever and never terminates. Builds
walk `queued -> submitting -> building -> verifying -> ready`, and any phase can land in `failed`
(`failure_stage` and `failure_message` say which). Pin only a `ready` version, or `createAgent`
answers `409 environment_not_ready`. On the Environment row, `latest_version` is the newest version
**created** - `1` the instant you create an Environment, while that version is still `queued` - and
`latest_ready_version` is the newest one that finished building, `null` until a build lands. **Pin
`latest_ready_version`.** `archiveEnvironment` exists mainly to get one character right: the route
is `POST /environments/{id}:archive`, and a raw `:` makes the engine miss the route and answer 404.
The SDK sends `%3A` for you; from another language, encode it yourself. `createEnvironmentVersion`
also reaches a real route, but its request body was never exercised against a live deployment - the
SDK sends `{ resource: { config } }`, mirroring create, on that symmetry alone, so verify before
depending on it. Versions are immutable: a retry after a failed build retries that version and keeps
its attempt log.

## Deprecated: the credential pair

```ts
/** @deprecated 404 for API-key callers. */
putCredential(agentId: string, app: string, body: Record<string, unknown>): Promise<void>
/** @deprecated 404 for API-key callers. */
listCredentials(agentId: string): Promise<{ app: string; ref: string }[]>
```

Both are still on the interface and both answer 404 through the gateway. The gateway seeds model
credentials itself, so there is nothing for an API-key caller to store; they remain for
deployment-internal callers only. Do not design around them, and do not read the 404 as a bug. One
consequence: `McpServerDeclaration.credential` names a credential slug that is accepted and stored
on the agent, but the endpoint that would hold the secret it points at is exactly `putCredential`,
so an authenticated MCP server cannot be made to work - declare public servers only. See
`references/not-supported.md` - Credentials and vaults.

## Errors

```ts
export class ZooclawError extends Error {
  status: number
  type?: string      // absent, not undefined-valued, when the server sent no code
  constructor(status: number, message: string, type?: string)
}
```

`this.name` is `'ZooclawError'` and the class is a runtime export, so `instanceof` works; the one
failure that is **not** a `ZooclawError` is the missing-key throw from `createZooclawClient`.
**There are two error vocabularies, because there are two envelopes.** The SDK unpacks both into the
same class, but the spelling differs by family:

| Family | Envelope | `type` looks like |
|---|---|---|
| sessions, schedules, environments | `{ error: { type, message } }` | bare: `agent_not_running`, `session_archived`, `environment_not_ready` |
| agents | `{ code, detail }` | dotted: `service_api.not_found` |

The message falls back through `error.message` -> `message` -> `detail` -> `HTTP <status>`; a
non-JSON error body leaves `type` absent. **No error-code constants are exported** - `type` is a
bare `string | undefined`, with no enum, union or const array anywhere in the package. You compare
against string literals you write yourself, which is why you should **match on `status` when you
only need the class of failure** and reach for `type` only to tell two failures with the same status
apart. Never match on message text: it is prose, it is not stable, and the same condition reaches
you differently worded depending on which envelope answered. Two more things a `catch` should
expect: a cross-tenant or unknown id answers **404, not 403**, so a 404 does not mean deleted; and
two errors never came from a server at all - `waitUntilRunning`'s `408 timeout` and `0 aborted`.
`streamEvents`' stream-open failure is a third `ZooclawError` you did not get from an error
envelope, but it does carry the response's real status, with an SDK-written message and no `type`.
