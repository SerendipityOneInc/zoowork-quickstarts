/**
 * HTTP API, mounted at /api/app. Multi-tenant: every request carries an authenticated
 * `userEmail` (injected by the composition root). All data is scoped to that email;
 * cross-user access is rejected (404, indistinguishable from missing).
 *
 *   GET  /me                    → { email }
 *   GET  /config                → what this deployment lets you configure (presence only)
 *   GET  /agent                 → which agent a NEW conversation would use, and why
 *   GET  /agents                → the org's agents (or an honest "list is unavailable")
 *   GET  /agents/:id            → one agent, for validating a pasted id
 *   POST /agents/:id/start      → start a bound agent that is not running
 *   PUT  /binding               → bind this user to an agent of their own
 *   DELETE /binding             → drop the binding (back to fixed / per-user)
 *   GET  /tasks                 → the caller's sessions (conversations)
 *   POST /tasks                 → create conversation + first turn
 *   POST /tasks/:id/prompts     → follow-up turn (same Zooclaw session)
 *   GET  /tasks/:id/content     → prompts + their frames (for reload, with self-heal)
 *   GET  /prompts/:id/stream    → SSE of frames until the turn ends (tail the store)
 *   POST /prompts/:id/cancel    → cancel the running turn
 *
 * The store + turn runner come from Hono context vars (set by worker/index.ts), so these
 * handlers don't know whether the store is D1 or the runner is a Durable Object
 * (template-layering ②) — which is what makes the whole API unit-testable over the
 * in-memory store with a fake runner.
 */
import { Hono, type Context, type Next } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Store, Task } from './store.ts'
import { ATTACHMENTS_ENABLED, attachmentPromptSuffix, MAX_UPLOAD_BYTES, type AgentConfig } from '../domain/agent.ts'
import { framesHaveAssistantText, healAttemptCount } from './frame-text.ts'
import { tailFrames } from './tail.ts'

/** Single default project (no project picker in this build). */
export const DEFAULT_PROJECT_ID = 'default'

/** An uploaded file's handle (opaque id + display filename). Owned by this layer: Zooclaw
 *  has no production file-staging API (domain/agent.ts ATTACHMENTS_ENABLED), so the shape
 *  exists for the display channel (bubble chips + renditions) and the future uploadFile. */
export interface FileRef {
  id: string
  filename: string
}

/**
 * One deployment variable, reported to the browser as PRESENCE ONLY.
 *
 * There is no `value` field and there must never be one: ZOOCLAW_API_KEY authenticates the
 * Worker as an entire organization, so shipping any variable's value to the browser is a
 * tenant-wide compromise. The Worker builds these rows from its declared variable registry
 * (worker/env.ts KIT_ENV_VARS); server/routes.test.ts asserts the shape so the field cannot
 * come back.
 */
export interface EnvVarStatus {
  name: string
  /** Set in this deployment? The value itself never leaves the Worker. */
  configured: boolean
  /** Carries a credential (`wrangler secret put`), as opposed to a plain wrangler var. */
  secret: boolean
  /** One line: what it changes, and where that lands in the ZooClaw API. */
  effect: string
}

/**
 * GET /config — a non-secret description of the running deployment, so a newcomer can see
 * WHICH mode the kit is in and WHICH variables are wired without reading the Worker source.
 * Built by worker/env.ts describeRuntime (the only file that knows the full Env).
 *
 * `runtime.apiBaseUrl` is the ONE env-derived value in this response: a public endpoint,
 * and the single fact a user cannot otherwise discover about their own deployment.
 *
 * ADDING A FIELD TO `runtime` MEANS EDITING server/routes.test.ts, which pins this object to
 * an exact key set. That is deliberate: the leak test can only search for whole sentinel
 * values, so a masked or truncated secret (`apiKeyPreview: 'zct_abc…'`) would pass it — the
 * key list is what forces a new field to be looked at.
 */
export interface RuntimeConfig {
  runtime: {
    /** How the Worker reaches the ZooClaw API. `unconfigured` → no ZOOCLAW_API_KEY, so no call can be made. */
    transport: 'gateway' | 'unconfigured'
    /** `fixed-agent` (ZOOCLAW_AGENT_ID: one shared agent, kit provisions nothing) or per-user provisioning.
     *  This is the deployment DEFAULT — a user binding (below) overrides it for that user. */
    provisioning: 'fixed-agent' | 'per-user'
    /** AGENT_PICKER: may a signed-in user bind an agent of their own? A capability flag, not
     *  a variable value — see worker/env.ts agentPickerEnabled for why it defaults to
     *  local-dev-only. The routes below enforce the same boolean. */
    agentPicker: boolean
    /** Who the Worker believes the caller is (worker/auth.ts). */
    identity: 'cloudflare-access' | 'dev-email' | 'unconfigured'
    /** EMBED_KEY is set → every /api/app/* call must present it. */
    embedGate: boolean
    /** domain/agent.ts ATTACHMENTS_ENABLED — ships false while the Files API is unwired. */
    attachments: boolean
    /** Resolved base URL every ZooClaw API call goes to. */
    apiBaseUrl: string
    apiBaseUrlFrom: 'ZOOCLAW_API_URL' | 'sdk-default'
  }
  env: EnvVarStatus[]
}

// ── agent directory + binding ──────────────────────────────────────────────

/**
 * Where the agent for a conversation came from. This is a WIRE value — it ships in the
 * `GET /agent` body and the panel renders it — so it lives here with the rest of the API
 * contract, and worker/provision.ts (which decides it) imports it from this layer, the same
 * direction worker/agent-directory.ts already reads AgentSummary.
 *
 * The order below IS the resolution order (worker/provision.ts resolveAgent), and only the
 * last is an agent this kit created:
 *
 *   conversation — pinned on the conversation's first turn (tasks.agent_id). Sessions are
 *                  agent-scoped, so an open conversation must never move.
 *   binding      — the user picked one of their own agents (agent_bindings, AGENT_PICKER).
 *   env-fixed    — ZOOCLAW_AGENT_ID: one pre-built agent shared by the whole deployment.
 *   per-user     — the kit provisioned it (zooclaw_agents), one per email.
 */
export type AgentSource = 'conversation' | 'binding' | 'env-fixed' | 'per-user'

/**
 * One agent as the panel sees it: the upstream AgentProjection reduced to the four fields
 * the picker actually renders. The trim matters — a list item carries the agent's ENTIRE
 * persona doc set, so shipping the raw projection would send kilobytes of somebody's prompt
 * to the browser for every row. The Worker trims (worker/index.ts), this is the shape.
 */
export interface AgentSummary {
  agentId: string
  name: string | null
  /** `declared.labels.workspace_id` — the first path segment of a ZooClaw chat URL, which is
   *  how a user recognises their agent. NOT every agent carries one, so it may be null. */
  workspaceId: string | null
  /** `status.desired_state` — `running` means it can take a message right now. */
  desiredState: string | null
}

/**
 * GET /agents. The `available: false` arm is a FIRST-CLASS state, not an error: the public
 * gateway does not forward collection-level GET and answers `404 service_api.not_found`
 * without consulting the engine (SDK note on listAgents; FEEDBACK #16). The panel degrades
 * to "paste an agent id" instead of showing a broken list, so the route reports the 404
 * rather than raising it.
 */
export type AgentDirectory =
  | {
      available: true
      agents: AgentSummary[]
      /** Rows the Worker dropped as Agent Builder test runs (worker/agent-directory.ts
       *  isBuilderTestRun). Reported rather than silently trimmed, so the list still adds up
       *  against what `listAgents()` returned. */
      hidden: number
    }
  | { available: false; status: number; code?: string }

/** GET /agent — the agent a NEW conversation would use, and what the UI may do about it. */
export interface EffectiveAgent {
  /** Which rule picked it (worker/provision.ts resolveAgent). */
  source: AgentSource
  /** Null only when provisioning is per-user and the first turn hasn't run yet. */
  agentId: string | null
  name: string | null
  desiredState: string | null
  /** May the Config tab write this agent's persona / tools / skill? True ONLY for an agent
   *  the kit created. A borrowed agent belongs to its author and is never PUT. */
  editable: boolean
  /** Is the picker live in this deployment (AGENT_PICKER)? */
  pickerEnabled: boolean
  /** Set when the upstream lookup for `agentId` failed — e.g. a bound agent that has since
   *  been deleted. The binding is left alone; the panel shows the problem and offers a reset. */
  lookupError?: { status: number; message: string }
}

/** Injected per-request by the composition root. */
export interface RouteVars {
  userEmail: string
  store: Store
  /** This deployment's non-secret runtime description, served verbatim by GET /config.
   *  Built once per request by the composition root (worker/index.ts describeRuntime), so
   *  this layer never touches Env — and cannot accidentally widen what it exposes. */
  runtimeConfig: RuntimeConfig
  /** Start the prompt's turn. False → another turn is already in flight on this
   *  conversation (the DO refused); the route marks the rejected prompt failed and
   *  answers 409 — accepting it would orphan a 'running' prompt forever. */
  runTurn: (
    taskId: string,
    projectId: string,
    promptId: string,
    prompt: string,
    opts?: { agentConfig?: AgentConfig },
  ) => Promise<boolean>
  cancelTurn: (promptId: string) => Promise<boolean>
  /** Answer a blocked `ask_user_question` on this conversation's Zooclaw session (posted as
   *  a user.tool_confirmation event) and nudge the runner to resume — the continuation
   *  streams into the SAME prompt's frames (the turn never left 'running' while blocked,
   *  so its stream is still attached). */
  answerQuestion: (
    taskId: string,
    body: { messageId: string; actionId: number; answer: unknown },
  ) => Promise<void>
  /** Backfill a finalized-but-empty turn's answer into the store, then return whether it
   *  recovered something. See GET /tasks/:id/content. */
  recoverPrompt: (taskId: string, promptId: string) => Promise<boolean>
  /** Upload one file for agent-side staging; returns its FileRef. Ships as a throwing stub
   *  (worker/index.ts) behind the ATTACHMENTS_ENABLED=false gate below — implement it when
   *  Zooclaw lands production file staging. */
  uploadFile: (file: { name: string; type: string; bytes: ArrayBuffer }) => Promise<FileRef>

  // ── agent directory + binding (worker/provision.ts owns the rules) ────────
  /** Which agent a NEW conversation would use — a pure lookup that provisions NOTHING, so
   *  opening the panel never creates an agent or bumps anyone's config_version. `managed` is
   *  the resolver's own verdict on whether the kit owns this agent (worker/provision.ts);
   *  this layer reports it rather than re-deriving it, so the Config tab's read-only state
   *  and the Worker's config-write gate can never disagree. */
  effectiveAgent: () => Promise<{ agentId: string | null; source: AgentSource; managed: boolean; name?: string | null }>
  /** The org's agents, already trimmed to AgentSummary. Resolves to `available: false` ONLY
   *  for the documented gateway 404; any other failure rejects, so a 500 surfaces as an
   *  error instead of as "paste an id instead" (see AgentDirectory). */
  listAgents: () => Promise<AgentDirectory>
  /** One agent, trimmed. `null` when upstream says 404 (unknown id, or not in this org);
   *  anything else throws so the route can report it honestly instead of as "not found". */
  getAgentSummary: (agentId: string) => Promise<AgentSummary | null>
  /** Start an agent that isn't running; false when upstream has no such agent. No credential
   *  heal — that is the kit's own provisioning path, and a borrowed agent's credentials are
   *  its author's business. */
  startAgent: (agentId: string) => Promise<boolean>
}

export const app = new Hono<{ Variables: RouteVars }>()

/** Load a task only if it belongs to the caller; else null (→ 404). */
async function ownedTask(store: Store, taskId: string, email: string): Promise<Task | null> {
  const task = await store.getTask(taskId)
  if (!task || task.user_email !== email) return null
  return task
}

app.get('/me', (c) => c.json({ email: c.var.userEmail }))

// What this deployment lets you configure. Read-only, and secret-free by construction:
// the composition root hands over an already-reduced RuntimeConfig (presence booleans, no
// values), so there is no Env in scope here to leak from.
app.get('/config', (c) => c.json(c.var.runtimeConfig))

// ── agent directory + binding ──────────────────────────────────────────────
//
// The picker hands a signed-in user the org key's reach: with it on, they can enumerate the
// organization's agents and point this deployment at any of them. So every route that reads
// the directory or writes a binding sits behind the same gate, and the gate is a deployment
// decision (AGENT_PICKER), never a client claim.

/** 403 body for every gated route below — one shape, so the panel needs one branch. */
const PICKER_OFF = { error: 'the agent picker is disabled in this deployment', code: 'agent_picker_disabled' } as const

/**
 * THE gate, as middleware rather than a line each handler has to remember. It guards a real
 * capability — an org-scoped API key means "list the directory" and "bind anything in it"
 * reach every agent in the organization — and a per-handler copy cannot enforce "every route
 * under these paths is gated": route six would ship open. Mounted on the path prefixes, so a
 * new route is gated by WHERE IT LIVES.
 */
app.use('/agents', pickerGate)
app.use('/agents/*', pickerGate)
app.use('/binding', pickerGate)
async function pickerGate(c: Context<{ Variables: RouteVars }>, next: Next): Promise<Response | void> {
  if (!c.var.runtimeConfig.runtime.agentPicker) return c.json(PICKER_OFF, 403)
  await next()
}

/** Resolve + describe the agent a NEW conversation would use. The upstream lookup is
 *  best-effort: a bound agent that has since been deleted must still render (with its
 *  error), because the reset button is the only way out of that state. */
async function describeEffectiveAgent(c: { var: RouteVars }): Promise<EffectiveAgent> {
  const { effectiveAgent, getAgentSummary, runtimeConfig } = c.var
  const eff = await effectiveAgent()
  const base: EffectiveAgent = {
    source: eff.source,
    agentId: eff.agentId,
    name: eff.name ?? null,
    desiredState: null,
    // The rule that protects other people's agents, taken from the resolver that also gates
    // the writes — never re-derived here (see RouteVars.effectiveAgent).
    editable: eff.managed,
    pickerEnabled: runtimeConfig.runtime.agentPicker,
  }
  if (!eff.agentId) return base // per-user, not provisioned yet — nothing upstream to ask about
  try {
    const found = await getAgentSummary(eff.agentId)
    if (!found) return { ...base, lookupError: { status: 404, message: 'this agent no longer exists on the configured ZooClaw API' } }
    return { ...base, name: found.name ?? base.name, desiredState: found.desiredState }
  } catch (e) {
    return { ...base, lookupError: { status: 0, message: (e as Error).message } }
  }
}

app.get('/agent', async (c) => c.json(await describeEffectiveAgent(c)))

app.get('/agents', async (c) => c.json(await c.var.listAgents()))

app.get('/agents/:id', async (c) => {
  const agentId = c.req.param('id')
  const found = await c.var.getAgentSummary(agentId)
  if (!found) return c.json(notFoundBody(agentId), 404)
  return c.json(found)
})

app.post('/agents/:id/start', async (c) => {
  // No existence pre-check: `startAgent` already reports an unknown id, and asking twice
  // would double the upstream round-trips on a button that is pressed to save time.
  const agentId = c.req.param('id')
  if (!(await c.var.startAgent(agentId))) return c.json(notFoundBody(agentId), 404)
  return c.json({ ok: true })
})

app.put('/binding', async (c) => {
  const { agentId } = await c.req.json<{ agentId?: string }>()
  const id = agentId?.trim()
  if (!id) return c.json({ error: 'agentId is required' }, 400)
  // Verify BEFORE storing: a binding to a non-existent agent would fail every later turn
  // with a much less obvious error, at send time instead of at save time.
  const found = await c.var.getAgentSummary(id)
  if (!found) return c.json(notFoundBody(id), 404)
  await c.var.store.saveAgentBinding(c.var.userEmail, found.agentId, found.name)
  // Answer from what the check just returned. Re-resolving would re-read the row we wrote
  // and ask upstream about the very agent we hold in hand; the outcome is not in doubt —
  // a binding always resolves to itself, and a borrowed agent is never editable.
  return c.json({
    source: 'binding',
    agentId: found.agentId,
    name: found.name,
    desiredState: found.desiredState,
    editable: false,
    pickerEnabled: c.var.runtimeConfig.runtime.agentPicker,
  } satisfies EffectiveAgent)
})

// Unlike PUT, this one must re-resolve: what a user falls back to (env-fixed or their own
// per-user agent) is exactly the thing the deleted row was hiding.
app.delete('/binding', async (c) => {
  await c.var.store.deleteAgentBinding(c.var.userEmail)
  return c.json(await describeEffectiveAgent(c))
})

/** A 404 that says what was looked up — and, for the one mistake this UI invites, what the
 *  user probably pasted instead. The first segment of a ZooClaw chat URL is a WORKSPACE id
 *  (an app-layer install record), not the `agt_…` engine id this route wants. */
function notFoundBody(agentId: string): { error: string; code: string; agentId: string; hint?: string } {
  return {
    error: `no agent ${agentId} on the configured ZooClaw API`,
    code: 'agent_not_found',
    agentId,
    ...(agentId.startsWith('agt_')
      ? {}
      : { hint: 'this does not look like an agent id — the first segment of a ZooClaw chat URL is a workspace id, not the agt_… id' }),
  }
}

app.get('/tasks', async (c) => {
  return c.json({ tasks: await c.var.store.listTasksByUser(c.var.userEmail) })
})

app.post('/tasks', async (c) => {
  const { store, runTurn, userEmail } = c.var
  const body = await c.req.json<{ prompt?: string; systemPrompt?: string; tools?: Record<string, boolean>; skillId?: string; files?: FileRef[] }>()
  const prompt = body.prompt
  if (!prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)

  // The conversation's agent config (system prompt + tool toggles + skill pin) is applied to the
  // user's Zooclaw agent on the first turn. Built only when the client sends it; otherwise the
  // runner uses its default. `skillId` is folded in only when present, so callers that never send
  // it keep the old 2-field shape (the worker installs it via PUT .../skills/{id} — see
  // worker/provision.ts).
  const agentConfig: AgentConfig | undefined =
    body.systemPrompt !== undefined || body.tools !== undefined || body.skillId !== undefined
      ? { systemPrompt: body.systemPrompt ?? '', tools: body.tools ?? {}, ...(body.skillId !== undefined ? { skillId: body.skillId } : {}) }
      : undefined

  const taskId = crypto.randomUUID()
  const promptId = crypto.randomUUID()
  await store.createTask(taskId, DEFAULT_PROJECT_ID, userEmail)
  await store.createPrompt(promptId, taskId, prompt) // store the user's text (shown in the UI)
  await store.linkPromptFiles(promptId, (body.files ?? []).map((f) => f.id)) // bubble attachments (display)
  // Wire prompt: append the attachment directive so the agent knows about uploaded files (the
  // staged workspace paths) and opens them. No-op when there are no files — which is always,
  // while attachments ship disabled; the flow stays correct if a vertical re-enables uploads.
  // Files ride the prompt text only: the turn runner takes no file refs (nothing to stage).
  const wirePrompt = prompt + attachmentPromptSuffix(body.files ?? [])
  if (!(await runTurn(taskId, DEFAULT_PROJECT_ID, promptId, wirePrompt, { agentConfig }))) {
    // Freshly-minted task ids can't collide with an in-flight turn in practice, but a
    // refused start must never leave the prompt stuck 'running'.
    await store.finishPrompt(promptId, 'failed')
    await store.setTaskStatus(taskId, 'failed')
    return c.json({ error: 'a turn is already running for this conversation' }, 409)
  }

  return c.json({ taskId, promptId })
})

app.post('/tasks/:id/prompts', async (c) => {
  const { store, runTurn, userEmail } = c.var
  const taskId = c.req.param('id')
  const task = await ownedTask(store, taskId, userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  const { prompt, files } = await c.req.json<{ prompt?: string; files?: FileRef[] }>()
  if (!prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)

  // Server-side busy guard: the frontend's busy flag is per-tab state — a second tab or
  // a direct API call must not start a concurrent turn (the DO would refuse it anyway;
  // refusing HERE avoids even creating the loser prompt row).
  const priors = await store.listPrompts(taskId)
  if (priors[priors.length - 1]?.status === 'running') {
    return c.json({ error: 'a turn is already running for this conversation' }, 409)
  }

  const promptId = crypto.randomUUID()
  await store.createPrompt(promptId, taskId, prompt) // store the user's text (shown in the UI)
  await store.linkPromptFiles(promptId, (files ?? []).map((f) => f.id)) // bubble attachments (display)
  await store.setTaskStatus(taskId, 'running')
  const wirePrompt = prompt + attachmentPromptSuffix(files ?? [])
  if (!(await runTurn(taskId, task.project_id, promptId, wirePrompt))) {
    // Race lost despite the guard (two concurrent submits passed the read) — the DO is
    // the tiebreaker. Mark the loser so it never sits 'running' forever.
    await store.finishPrompt(promptId, 'failed')
    return c.json({ error: 'a turn is already running for this conversation' }, 409)
  }

  return c.json({ promptId })
})

app.post('/files', async (c) => {
  // Eager upload of ONE attachment (multipart): `file` (the original, staged for the agent) plus
  // optional `thumb`/`large` WebP renditions, persisted keyed by the returned file id for the
  // chat bubble + lightbox. Returns the FileRef the next turn rides on.
  // GATED FIRST, before touching the body: Zooclaw Files is a text-content contract with no
  // production staging, so the kit ships with uploads off (domain/agent.ts ATTACHMENTS_ENABLED)
  // and this route refuses without reading a byte of the form into Worker memory.
  if (!ATTACHMENTS_ENABLED) return c.json({ error: 'attachments disabled: Zooclaw Files is not production-wired' }, 501)
  const { uploadFile, store, userEmail } = c.var
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ error: 'no file' }, 400)
  // Server-side cap (defense in depth — the Composer already gates, but a bypassed client can't
  // get past this). Checked on file.size, before reading the body into Worker memory.
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large' }, 413)
  const thumb = form.get('thumb')
  const large = form.get('large')
  // Decode the three independent multipart parts concurrently; only the staging upload below
  // needs the original bytes (and saveAttachment needs its returned id), so those two stay
  // sequential.
  const [bytes, thumbBytes, largeBytes] = await Promise.all([
    file.arrayBuffer(),
    thumb instanceof File ? thumb.arrayBuffer() : Promise.resolve(null),
    large instanceof File ? large.arrayBuffer() : Promise.resolve(null),
  ])
  const ref = await uploadFile({ name: file.name, type: file.type, bytes })
  await store.saveAttachment(ref.id, userEmail, file.name, file.type, thumbBytes, largeBytes)
  return c.json({ id: ref.id, filename: ref.filename })
})

app.get('/files/:fileId', async (c) => {
  // Authed image serve: stream a stored WebP rendition (thumb|large) for the bubble/lightbox.
  // Scoped to the uploader's email — the worker holds ONE the ZooClaw API service token, so this check
  // is the real per-user gate (mirrors ChatGPT serving images through an authed backend, not a
  // CDN URL).
  const { store, userEmail } = c.var
  const size = c.req.query('size') === 'large' ? 'large' : 'thumb'
  const att = await store.getAttachment(c.req.param('fileId'), size)
  if (!att || att.userEmail !== userEmail) return c.json({ error: 'not found' }, 404)
  return c.body(att.bytes, 200, {
    'Content-Type': 'image/webp',
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
})

app.get('/tasks/:id/content', async (c) => {
  const { store, userEmail } = c.var
  const task = await ownedTask(store, c.req.param('id'), userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  const rows = await store.listPrompts(task.id)
  const prompts = await Promise.all(
    rows.map(async (p) => {
      let frames = await store.framesSince(p.id, 0)
      // Self-heal a terminal turn the UI can't show (nothing landed). A refresh reads only
      // the store, so ask the backend to backfill from the session transcript, then
      // re-read. No-op for whole turns (streaming-experience-contract R3). Bounded:
      // canceled turns never heal (no answer expected), and after 2 failed attempts
      // (__heal_attempted marker frames) the prompt stops triggering upstream transcript
      // reads — the service token is shared, so unbounded per-load reads would be a
      // cross-tenant availability amplifier.
      const needsHeal =
        p.status !== 'running' && p.status !== 'canceled' && !framesHaveAssistantText(frames) && healAttemptCount(frames) < 2
      if (needsHeal && (await c.var.recoverPrompt(task.id, p.id))) frames = await store.framesSince(p.id, 0)
      // Metadata only — the client derives the rendition URLs (single source: api.toAttachment), so
      // the reloaded bubble matches the optimistic one byte-for-byte (I0).
      const attachments = await store.listPromptAttachments(p.id)
      return { id: p.id, prompt: p.prompt, status: p.status, frames, attachments }
    }),
  )
  return c.json({ task: { id: task.id, status: task.status }, prompts })
})

app.get('/prompts/:id/stream', async (c) => {
  const { store, userEmail } = c.var
  const promptId = c.req.param('id')
  const p = await store.getPrompt(promptId)
  if (!p || !(await ownedTask(store, p.task_id, userEmail))) return c.json({ error: 'not found' }, 404)

  const fromSeq = Number(c.req.query('fromSeq') ?? c.req.header('Last-Event-ID') ?? 0) || 0
  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => {
      aborted = true
    })
    await tailFrames(
      store,
      promptId,
      fromSeq,
      async (line) => {
        await stream.write(line)
      },
      () => !aborted,
    )
  })
})

app.post('/tasks/:id/answer', async (c) => {
  const { store, userEmail, answerQuestion } = c.var
  const taskId = c.req.param('id')
  const task = await ownedTask(store, taskId, userEmail)
  if (!task) return c.json({ error: 'task not found' }, 404)

  // `answer` is an opaque JSON value (option pick `{ selectedOptions, customResponse? }`, a form's
  // `{ values }`, …) — the resumed ask_user_question tool owns its interpretation, so the route only
  // checks the ids + that an answer is present; the triple is passed through to the session as a
  // user.tool_confirmation event (see worker/index.ts).
  const body = await c.req.json<{ messageId?: string; actionId?: number; answer?: unknown }>()
  if (!body.messageId || typeof body.actionId !== 'number' || body.answer === undefined) {
    return c.json({ error: 'messageId, actionId, answer are required' }, 400)
  }
  await answerQuestion(taskId, { messageId: body.messageId, actionId: body.actionId, answer: body.answer })
  return c.json({ ok: true })
})

app.post('/prompts/:id/cancel', async (c) => {
  const { store, userEmail, cancelTurn } = c.var
  const promptId = c.req.param('id')
  const p = await store.getPrompt(promptId)
  if (!p || !(await ownedTask(store, p.task_id, userEmail))) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: await cancelTurn(promptId) })
})
