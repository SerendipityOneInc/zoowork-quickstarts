# ZooClaw - Deploying an Agent You Built Locally

You have a persona, one or more skill directories, and a front end you can host. What you do not
have is somewhere for the agent loop and its skills to run. This file turns that into a hosted
agent: one `agt_` id, its skills uploaded and attached, verified by a real turn, with your own
backend in front of it.

Run the steps in order, and perform each verification - several of these calls report success in
ways that do not prove the effect landed. `putAgentSkill` returns a bumped `config_version` whether
or not the skill resolved, `triggerSchedule` returns `triggered: true` for a schedule that was
skipped, and `exec` returns HTTP 200 for a command that failed. Code is TypeScript against
`@zooclaw-agents/sdk`, ESM, Node 20 or later, top-level await, and every snippet assumes this
preamble:

```ts
import { readFile } from 'node:fs/promises'
import { createZooclawClient, assistantText, isRunFinished, runOutcome, toolCall } from '@zooclaw-agents/sdk'

const zc = createZooclawClient() // reads ZOOCLAW_API_KEY; throws at construction if unset
```

---

## Step 0. Take stock

Map what you have onto what ZooClaw stores, before you write a call. Three of these rows are
one-way doors.

| What you built locally | Where it goes | What to know |
|---|---|---|
| System prompt, persona file, `CLAUDE.md` / `AGENTS.md` | `resource.persona.docs[]` on `createAgent` | An array of `{ name, content }`, not a map. Editable later with `updateAgent` |
| A skill directory containing `SKILL.md` | A zip, uploaded with `uploadSkill`, attached with `putAgentSkill` | Two calls, and the upload alone attaches nothing. Steps 4 and 5 |
| Custom tool / function definitions | **Nowhere.** There is no custom tool type and no tool-result event | Redesign this now, not after the first integration test - `references/not-supported.md` - Custom tools names the two real alternatives |
| A local working directory of files | `/workspace` inside the agent's sandbox | With `sandbox.scope: 'agent'` there is one `/workspace` shared by every session, so it is agent state, not conversation state |
| Your chat UI | Stays yours | It talks to your backend, never to ZooClaw. Step 9 |
| Per-end-user secrets or accounts | **Nowhere.** Vaults do not exist and `putCredential` is `@deprecated` and 404s | `references/not-supported.md` - Credentials |

Decide these at create time. Two of them cannot be undone:

- **`sandbox.scope`** - `agent` gives one long-lived `/workspace` across all sessions and is
  required by `exec`; `session` gives a fresh one per session and makes `warm` a no-op. Pick
  `agent` for a deck editor whose files should persist between conversations.
- **The Environment** - optional, and a default is already pinned. The pin **freezes permanently**
  the first time a sandbox is created (`agent.environment_locked` flips to `true`); stopping the
  agent does not release it, and a later change is `409 environment_locked`. If you need custom
  apt/npm/pip packages baked in, build and pin it on `createAgent`; otherwise ignore it forever.
- **`onboarding: false`** - leave it out and the agent spends its first turn interviewing you about
  its own persona instead of answering. `skipped` is terminal.

---

## Step 1. Choose a model from `listModels()`

Model ids here are prefixed (`litellm/claude-sonnet-5`), so a name recalled from another platform
is a 400 rather than a fallback. Ask the server what exists.

```ts
const models = await zc.listModels()
const model = models.find((m) => m.model.includes('sonnet'))?.model ?? models[0]?.model
if (!model) throw new Error('no models available to this key')
```

**Verify:** the list is non-empty and `model` is a full id including its prefix. This call touches
no agent and creates nothing, so it doubles as the cheapest proof the key works.

---

## Step 2. Create the agent

`persona.docs` is where the local system prompt lands. Each entry is a named document the agent
reads as standing instruction; give it the same name you used locally so the content stays
recognizable in `getAgent().declared`.

`labels` earn their keep immediately: `listAgents({ labels })` filters on them server-side, which
is how you find this agent again from a fresh process without a database.

```ts
const LABELS = { app: 'deck-editor', env: 'prod' }
const persona = await readFile('./AGENTS.md', 'utf8')

// Converge on ONE agent instead of creating another on every deploy.
const existing = await zc.listAgents({ labels: LABELS })
let agentId = existing[0]?.agent_id

if (!agentId) {
  const created = await zc.createAgent(
    {
      resource: {
        name: 'deck-editor',
        model: { primary: model },
        persona: { docs: [{ name: 'AGENTS.md', content: persona }] }, // ARRAY of {name, content}
        labels: LABELS,
        sandbox: { scope: 'agent' }, // one /workspace for the agent; required by exec
        warm: true,                  // CREATE ONLY - a PUT carrying it is a 400
        onboarding: false,           // skip the persona interview; terminal once set
      },
      // Required by the schema and then overwritten by the gateway with your key's tenant.
      ownership: { owner_uid: 'placeholder', org_id: 'placeholder' },
    },
    'deck-editor-prod-v1', // stable idempotency key, NOT a per-deploy uuid
  )
  agentId = created.agent_id // agt_... - persist this
}
```

**Why the idempotency key matters more here than anywhere else.** A duplicate session is a wasted
turn; a duplicate *agent* is a second sandbox, a second `/workspace`, a second set of attached
skills, and a second id that half your traffic is now talking to. Nothing in the product cleans
that up, and the two agents drift the moment either one writes a file. Know what the key does and
does not buy you, though: the SDK forwards it as an `Idempotency-Key` header, and the only
create-family convergence the SDK pins down is `createSchedule`. The `listAgents` lookup above is
the part you can verify, and its one limit is scope - it queries `owner_uid AND org_id`, so an agent
a colleague created with a different key will not appear and you would make a second one. On a
shared deployment, store the id.

**Verify:**

```ts
const agent = await zc.getAgent(agentId)
console.log(agent.status?.config_version, Object.keys(agent.declared ?? {}))
```

The read is a different shape from the create receipt: `getAgent` returns a projection with your
configuration under `declared` and the version at `status.config_version`, while `createAgent`
returned a flat receipt with a top-level `config_version` and no `declared` at all - read it as
`agent.status?.config_version ?? agent.config_version` if you need one expression for both. Confirm
`declared.persona` holds the text you sent; that is the proof the persona landed, not the 201.

**On `tool_policy`.** The SDK types it `Record<string, unknown>` and pins no key names, and the only
value ever observed on a real agent is the empty object `{}`. Omit it unless your deployment handed
you a concrete policy vocabulary - anything you invent is unverified, and the create will not tell
you which of your keys it ignored.

---

## Step 3. Start it, and wait on `desired_state`

A newly created agent is not running. Every session call against it is `409 agent_not_running` until
you start it.

```ts
const { warnings } = await zc.startAgent(agentId)
// `channel_routes_reload_failed` is normal for an API-only agent: it has no chat channels to
// reload. Do not treat it as a failure.
if (warnings.length) console.log('start warnings:', warnings)

const running = await zc.waitUntilRunning(agentId, { timeoutMs: 60_000 })
console.log(running.status?.desired_state) // 'running'
```

Do not hand-roll this loop. The readable-looking field, `status.actual_state`, reports chat-channel
health: `running` is not one of its values, and an API-only agent parks at `activating` for the rest
of its life, so a loop waiting on it never returns. `waitUntilRunning` polls `desired_state`, bounds
each in-flight request as well as the gap between polls, and throws a `ZooclawError` with
`status: 408` / `type: 'timeout'` when the budget runs out.

**Verify:** `running.status?.desired_state === 'running'`. Nothing else is readiness.

---

## Step 4. Package each skill directory as a zip

**The zip's single top-level directory name must equal the `name` in that directory's `SKILL.md`
frontmatter.** This is the first failure nearly everyone hits, and the error names both halves:
`top-level directory 'deck-notes' must match SKILL.md name 'deck-review'`. The comparison is
case- and underscore-insensitive, so `Deck_Review/` matching `deck-review` passes, but a directory
you renamed to something else locally does not.

```bash
cd ~/projects/deck-editor/skills
# Write the archive OUTSIDE the directory being zipped so it cannot include itself.
zip -q -r -X ../deck-review.zip deck-review
```

A zip whose root *is* the skill (`SKILL.md` at the top level, no wrapping directory) is also
accepted. Limits: 50 MB expanded, zip only, store or deflate, encrypted archives rejected.

The frontmatter has to satisfy the server too. `SKILL.md` must be non-empty and declare both `name`
and `description`; keep `name` to lowercase letters, digits and hyphens (`^[a-z0-9-]{1,64}$` is the
SKILL.md convention - the SDK pins only the non-empty and directory-match rules). The `description`
is not decoration: it is what the agent matches on when deciding whether this skill is relevant to
the message in front of it, so "Deck helper" gets the skill ignored forever. Write what it does and
when to reach for it - "Reviews and edits PowerPoint decks: slide structure, speaker notes, template
compliance. Use when the user mentions a deck, .pptx, or slides."

```ts
const zip = await readFile('/abs/path/deck-review.zip') // Buffer is a Uint8Array - accepted as-is

const skill = await zc.uploadSkill(zip, {
  scope: 'org',                      // 'org' | 'personal' only; 'global' and 'pack' are 403
  fileName: 'deck-review.zip',
  idempotencyKey: 'deck-review-v1',
})
console.log(skill.skill_id, skill.name, skill.latest_version)
```

One call creates the skill row and version 1. It does **not** attach anything to any agent.

**Verify:**

```ts
const found = await zc.listSkills({ q: 'deck-review' })
const mine = found.filter((s) => s.scope === 'org' || s.scope === 'personal')
if (mine.length !== 1) throw new Error(`expected 1 owned skill row, saw ${mine.length}`)
if (Number(skill.latest_version) !== 1) throw new Error('version 1 was not created')
```

Two things this catches. `latest_version` comes back as the **string** `"1"` from the multipart
create while other surfaces spell it as a number, so compare with `Number()`. And more than one row
means a retried upload created a duplicate skill with the same name and a different id - after an
upload times out, reconcile with `listSkills({ q: name })` before uploading again.

Repeat per skill directory. The `global` catalog entries in `listSkills` (`docx`, `pptx`, `xlsx`,
`pdf` and friends) are already attached to every agent and are not installable with an API key; do
not write a provisioning step that tries.

---

## Step 5. Attach, then prove the attachment resolved

```ts
const put = await zc.putAgentSkill(agentId, skill.skill_id) // { config_version, warnings }
```

`put.config_version` is not proof. Every `PUT` on the agent bumps the version, including one that
changed nothing, and the gateway bumps it on its own besides - so a bumped version tells you a
write happened, not that the skill resolved onto this agent. Read it back:

```ts
const attached = await zc.listAgentSkills(agentId)
const row = attached.find((s) => s.skill_id === skill.skill_id)
if (!row) throw new Error('skill did not resolve onto the agent')
if (row.eligible === false) throw new Error(`attached but ineligible: ${JSON.stringify(row)}`)
console.log(row.name, row.version, row.location) // e.g. deck-review 1 /skills/deck-review/SKILL.md
```

`row.location` is worth keeping: it is the path the skill materializes at inside the sandbox, and
Step 6 uses it as the evidence that the model actually read the file. Call
`listAgentSkills(agentId, { verbose: true })` when a skill is missing - verbose includes the
ineligible and excluded entries, which is where the reason lives.

**Pinning versus following latest.**

| Call | Effect |
|---|---|
| `putAgentSkill(agentId, skillId)` | Attached, enabled, **unpinned** - follows the newest version |
| `putAgentSkill(agentId, skillId, { versionPin: 3 })` | Frozen at version 3 until you change it |
| `putAgentSkill(agentId, skillId, { versionPin: null })` | Back to following latest |
| `putAgentSkill(agentId, skillId, { enabled: false })` | Attached but off, without detaching |
| `deleteAgentSkill(agentId, skillId)` | Detached |

Shipping an edit to a skill is therefore one call, not two:

```ts
await zc.uploadSkillVersion(skill.skill_id, await readFile('/abs/path/deck-review.zip'), {
  fileName: 'deck-review.zip',
  idempotencyKey: 'deck-review-v2',
})
// Unpinned agents follow the new version on their own - the registry bumps their config_version.
// Do NOT re-run putAgentSkill; it is not what propagates the update.
```

The frontmatter `name` in the new zip must still match the target skill's name, and a `description`
passed here overrides the one in the frontmatter.

**Neither call is a safe blind retry after a timeout.** `putAgentSkill` is a `PUT` on the agent and
`uploadSkillVersion` mints a new immutable version; a request that timed out on your side may well
have landed on theirs. Reconcile instead: `listAgentSkills` tells you whether the attach took, and
`listSkills({ q: name })` tells you what `latest_version` actually is.

---

## Step 6. Smoke test with a real turn that should use a skill

Ask for something only the skill knows how to do. A generic "hello" proves the agent runs and
proves nothing about the deployment you just performed.

```ts
const session = await zc.createSession(agentId, {
  initial_events: [
    { type: 'user.message', content: 'Review the structure of a 12-slide pitch deck and list what is missing.' },
  ],
  metadata: { origin: 'deploy-smoke-test' }, // write-once: there is no patchSession
})

let reply = ''
let lastSeq = 0
const calls: string[] = []

for await (const ev of zc.streamEvents(agentId, session.session_id)) {
  lastSeq = ev.seq
  reply += assistantText(ev) // '' for every event that is not agent.assistant
  const call = toolCall(ev)
  if (call?.phase === 'start') calls.push(`${call.toolName} ${JSON.stringify(call.args ?? {})}`)
  if (isRunFinished(ev)) {
    if (runOutcome(ev) !== 'succeeded') throw new Error(`run ${runOutcome(ev)}`)
    break // the stream is session-scoped and does NOT close at turn end
  }
}

const consulted = calls.some((c) => c.includes('/skills/deck-review/'))
console.log({ consulted, calls, reply: reply.slice(0, 200), lastSeq })
```

**How to read that.** No event announces "skill selected". What happens is that the model reads the
skill file, and reading a file is a tool call - so a matching `agent.tool` event is the evidence.
Match on the skill's path (`row.location` from Step 5) appearing in the call's `args` rather than on
a tool name: which tool the runtime uses to read files is not pinned anywhere in the SDK, and
hardcoding a guess makes your check fail for the wrong reason. If `consulted` is false but the run
succeeded, the usual cause is a description too vague to match on - fix it and publish a new version.

Two consequences of that same mechanism. **Using a skill always creates the sandbox**, because the
file has to be read somewhere - that is where first-call latency comes from, roughly 5 to 7 seconds
of cold start, which `warm: true` on create pays up front instead. And **the first sandbox freezes
the Environment pin** for the life of the agent, so if you were ever going to pin a custom
Environment, it had to happen before this turn.

---

## Step 7 (optional). Look inside `/workspace` with `exec`

When the agent's answers suggest it is not seeing the files you think it is, inspect the sandbox
directly.

```ts
const out = await zc.exec(agentId, ['bash', '-lc', 'ls -la /workspace && head -20 /skills/deck-review/SKILL.md'])
if (out.exit_code !== 0) console.error('command failed:', out.exit_code, out.stderr)
console.log(out.stdout)
```

`args` is argv, not a shell string - `['ls', '/workspace']` runs `ls`, and anything with a pipe, a
redirect, or a glob needs the explicit `['bash', '-lc', '...']` wrapper. **A non-zero exit is still
HTTP 200:** the promise resolves and only `exit_code` tells you the command failed; the call rejects
only when the call itself fails. `cwd` is fixed to `/workspace`, the default timeout is 300s, and
stdout and stderr are each capped
at 200,000 characters. Three failures are configuration rather than bugs: `409
exec_requires_agent_scope` (you created the agent with `sandbox.scope: 'session'`),
`409 exec_config_not_ready` (config not rendered yet - worth one retry after a few seconds), and
`501 not_configured` (the deployment has no sandbox backend).

---

## Step 8 (optional). Put it on a schedule

```ts
await zc.createSchedule(
  agentId,
  {
    schedule_id: 'nightly-deck-audit', // ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, // five fields, no macros
    payload: { kind: 'agentTurn', message: 'Audit the decks in /workspace and summarize changes.' },
    sessionTarget: 'isolated', // fresh session per fire; IMMUTABLE after create
    delivery: { mode: 'none' },
    enabled: true,
  },
  'nightly-deck-audit-v1',
)
```

**Verify.** The create receipt carries only `schedule_name`, not the definition, so read it back.
The read spells everything differently from the write: your id is at `name` (`scheduleId` is the
fully-qualified `cron/{computer_id}/{agent_id}/{schedule_id}`), and the cadence is at
`scheduleSpec.cronExpressions[0]` - there is no `schedule` key on any read.

```ts
const stored = await zc.getSchedule(agentId, 'nightly-deck-audit') // the SHORT id you chose
console.log(stored.name, stored.enabled, stored.scheduleSpec?.cronExpressions?.[0])
```

Three things to know before you rely on this:

- **Schedules outlive their agent.** `stopAgent` and `deleteAgent` leave them in place. You list and
  delete them yourself - see Step 10.
- **A `getSchedule()` result is not a legal PUT body.** Four of its fields are server-derived and
  answer 400, `sessionTarget` is `400 sessionTarget is immutable`, and `scheduleSpec` - the only
  place a read puts the cadence - is accepted with a 200 and then silently ignored. To change the
  cadence, send `schedule: { kind: 'cron', expr, tz }`, the input vocabulary. The types refuse all
  six at compile time and the SDK strips them at runtime, so the read-tweak-write round trip works
  from TypeScript; from plain JavaScript, know what you are sending.
- **Overlap policy is skip.** A fire that lands while the previous one is still running is dropped,
  not queued. Size the cadence for the slowest run you expect.

To find what a fire produced: `listScheduleRuns` returns dispatch rows and outcome rows and neither
carries a `session_id`, so walk it from the other end - `listSessions(agentId)` and match
`channel === 'cron'` with a `session_key` beginning `agent:{agent_id}:cron:{schedule_id}:`. And
`triggerSchedule` answering `triggered: true` means dispatched, never that the turn ran; a disabled
schedule answers `triggered: true` while the run projection records `status: "skipped"`.

---

## Step 9. Wire up your own front end

**The key is an organization credential with full read and write over every agent in the org.** It
is not a per-user token and there is no way to scope it down. So it lives in your backend, in a
server-side secret store, and never in a browser bundle, a mobile app, or a build-time inlined
variable. Everything else about the integration follows from that single fact.

The shape is `browser -> your backend -> ZooClaw`, where your backend holds `ZOOCLAW_API_KEY`,
authenticates your user, and looks up the sessions it created for them. One agent, one session per
conversation, is the normal design: the agent is the product, the session is the thread.

```ts
// POST /api/conversations - your route, your auth
const user = await authenticateYourUser(req)      // your problem, not ZooClaw's
const session = await zc.createSession(AGENT_ID, {
  metadata: { user_id: user.id },                 // write-once, at create
})
await yourDb.conversations.insert({ user_id: user.id, session_id: session.session_id })

// POST /api/conversations/:id/messages
const row = await yourDb.conversations.findOne({ id, user_id: user.id }) // authorize HERE
await zc.postEvents(AGENT_ID, row.session_id, [{ type: 'user.message', content: req.body.text }])
```

**You must store the session ids yourself.** `listSessions` is per-agent
(`listSessions(agentId, { page })`, newest first, 50 per page, no cursor); there is no cross-agent
session listing and no way to query sessions by end user. The `metadata` you set at create is
readable but not searchable, and write-once besides - there is no `patchSession`. Your database is
the index, and it is also your authorization boundary: the SDK will read any session in the org if
you hand it an id, so the check that this session belongs to this user is yours to make.

Per-user context belongs in the session, not in the agent - post a `system.message` event to tell
the agent which plan the user is on or what they just clicked, rather than creating an agent per
user or rewriting the persona.

For streaming, your backend runs `streamEvents` and re-emits to the browser in whatever format your
UI wants, keeping the last `seq` it forwarded per connection and resuming with `{ after: lastSeq }`
- the SDK does not reconnect for you. See `references/events-and-streaming.md` - Reconnecting. If
this sounds like a week of work, the App Kit already implements all of it; see the SKILL.md section
"The App Kit path" before building it yourself.

---

## Step 10. Tear down a throwaway experiment

Order matters, because `deleteAgent` is a soft delete that stops nothing and cleans up nothing.

```ts
// 1. Schedules first - they outlive the agent, and after deletion you still need agentId to
//    address them, but a deleted agent's schedules go on firing.
for (const s of await zc.listSchedules(agentId)) {
  const id = s.name ?? (s.memo?.schedule_id as string | undefined)
  if (id) await zc.deleteSchedule(agentId, id)
}

// 2. Stop - deleteAgent does not do this, and does not release the sandbox either.
await zc.stopAgent(agentId)

// 3. Delete the agent.
await zc.deleteAgent(agentId)

// 4. Skills are org-level, not agent-level, so they survive the agent. Delete the throwaway ones.
await zc.deleteSkill(skill.skill_id) // 204; no in-use guard - other agents holding it lose it
```

**Verify:** `listSchedules(agentId)` is empty before you delete, and `listAgents({ labels: LABELS })`
no longer returns the agent afterwards. A 404 from `getAgent` is not proof of deletion on its own -
an unknown or cross-tenant id answers 404 too, so a typo looks exactly like success.
