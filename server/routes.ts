/**
 * HTTP API, mounted at /api/app. Multi-tenant: every request carries an authenticated
 * `userEmail` (injected by the composition root). All data is scoped to that email;
 * cross-user access is rejected (404, indistinguishable from missing).
 *
 *   GET  /me                    → { email }
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
import { Hono } from 'hono'
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

/** Injected per-request by the composition root. */
export interface RouteVars {
  userEmail: string
  store: Store
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
}

export const app = new Hono<{ Variables: RouteVars }>()

/** Load a task only if it belongs to the caller; else null (→ 404). */
async function ownedTask(store: Store, taskId: string, email: string): Promise<Task | null> {
  const task = await store.getTask(taskId)
  if (!task || task.user_email !== email) return null
  return task
}

app.get('/me', (c) => c.json({ email: c.var.userEmail }))

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
