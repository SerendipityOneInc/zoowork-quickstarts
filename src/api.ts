import type { AgentConfig } from '../domain/agent.ts'
// TYPE-ONLY (erased at build — verbatimModuleSyntax): the runtime description is an API
// response contract, so the client reads the server's definition instead of keeping a
// second copy that could drift. No server code enters the browser bundle.
import type { RuntimeConfig } from '../server/routes.ts'

export type { EnvVarStatus, RuntimeConfig } from '../server/routes.ts'

const BASE = '/api/app'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init)
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${r.status}`)
  return r.json() as Promise<T>
}
const postJson = <T>(path: string, body: unknown): Promise<T> =>
  json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Server-sent attachment metadata; the rendition URLs are derived client-side (see toAttachment). */
export interface AttachmentMeta {
  fileId: string
  filename: string
  contentType: string
}

/** A bubble attachment with its authed rendition URLs (the `<img src>` targets, GET
 *  /api/app/files/:id?size=…) — rendered above the user bubble text. */
export interface Attachment extends AttachmentMeta {
  thumbUrl: string
  largeUrl: string
}

/** What the composer hands up per attachment on send: the stored file id + name + type. The
 *  id+filename ride on the turn as the FileRef; all three seed the optimistic bubble. */
export interface SentAttachment {
  id: string
  filename: string
  contentType: string
}

export interface PromptContent {
  id: string
  prompt: string
  status?: string
  frames: { seq: number; data: unknown }[]
  attachments?: Attachment[]
}

/** One conversation in the per-user session list. */
export interface SessionSummary {
  id: string
  status: string
  created_at: string
  title: string
}

/** The signed-in user (from the auth provider). 401 → not authenticated. */
export const getMe = (): Promise<{ email: string }> => json('/me')

/** What this deployment lets you configure: mode flags, the resolved API base URL, and
 *  presence-only status per env var. Never carries a secret VALUE — see server/routes.ts
 *  RuntimeConfig and the leak test in server/routes.test.ts. */
export const getConfig = (): Promise<RuntimeConfig> => json('/config')

/** The caller's sessions (newest first). */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await json<{ tasks: SessionSummary[] }>('/tasks')).tasks
}

/** A reference to an uploaded file (temp-file id + normalized name). Part of the
 *  disabled-attachments seam (domain/agent.ts ATTACHMENTS_ENABLED): Zooclaw has no file
 *  staging yet, so nothing rides the wire today — the shape is kept so flipping the flag
 *  back on is a worker-side change, not a frontend rewrite. */
export interface FileRef { id: string; filename: string }

/** Authed URL for a stored image rendition (the chat bubble / lightbox `<img src>`). Matches what
 *  GET /tasks/:id/content returns, so the optimistic and reloaded views are identical (I0). */
export const fileUrl = (fileId: string, size: 'thumb' | 'large'): string => `${BASE}/files/${fileId}?size=${size}`

/** Derive a bubble Attachment from server metadata — the ONE place rendition URLs are built, so
 *  the optimistic (send) and reloaded (/content) views are byte-identical (I0). */
export const toAttachment = (m: AttachmentMeta): Attachment => ({ ...m, thumbUrl: fileUrl(m.fileId, 'thumb'), largeUrl: fileUrl(m.fileId, 'large') })

/** Eager-upload ONE file (multipart) via the worker. Disabled-attachments seam: the worker's
 *  uploadFile stub throws until Zooclaw lands file staging (see ATTACHMENTS_ENABLED in
 *  domain/agent.ts) — the composer never calls this while the flag is off. */
export async function uploadFile(file: File, renditions: { thumb: Blob; large: Blob } | null): Promise<FileRef> {
  const fd = new FormData()
  fd.append('file', file)
  if (renditions) {
    fd.append('thumb', renditions.thumb, 'thumb.webp')
    fd.append('large', renditions.large, 'large.webp')
  }
  const r = await fetch(`${BASE}/files`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`upload failed: ${r.status}`)
  return (await r.json()) as FileRef
}

/** Create a session + first turn. `config` (system prompt + tool toggles + skill id) is applied to
 *  the user's Zooclaw agent on this first turn; follow-ups reuse it. `skillId` (a `skl_...`
 *  registry id) only rides the wire when set — empty/whitespace means "no skill", sent as nothing. */
export const createTask = (prompt: string, config?: AgentConfig, files?: FileRef[]): Promise<{ taskId: string; promptId: string }> =>
  postJson('/tasks', {
    prompt,
    ...(config
      ? { systemPrompt: config.systemPrompt, tools: config.tools, ...(config.skillId?.trim() ? { skillId: config.skillId.trim() } : {}) }
      : {}),
    ...(files?.length ? { files } : {}),
  })

export const followup = (taskId: string, prompt: string, files?: FileRef[]): Promise<{ promptId: string }> =>
  postJson(`/tasks/${taskId}/prompts`, files?.length ? { prompt, files } : { prompt })

/** Answer a blocked `ask_user_question` and resume the turn. `answer` is an arbitrary JSON value the
 *  resumed tool interprets — `{ selectedOptions, customResponse? }` for an option/free-text pick, or
 *  a form's `{ values }`. The reply streams back on the SAME prompt's SSE. */
export const answerQuestion = (
  taskId: string,
  input: { messageId: string; actionId: number; answer: unknown },
): Promise<{ ok: boolean }> => postJson(`/tasks/${taskId}/answer`, input)

export async function loadContent(
  taskId: string,
): Promise<{ task: { id: string; status: string }; prompts: PromptContent[] } | null> {
  const r = await fetch(`${BASE}/tasks/${taskId}/content`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`loadContent failed: ${r.status}`)
  const data = (await r.json()) as {
    task: { id: string; status: string }
    prompts: Array<Omit<PromptContent, 'attachments'> & { attachments?: AttachmentMeta[] }>
  }
  // Derive rendition URLs client-side (single source: toAttachment) so a reload matches the
  // optimistic view the composer built with the same helper (I0).
  return { task: data.task, prompts: data.prompts.map((p) => ({ ...p, attachments: p.attachments?.map(toAttachment) })) }
}

/** Streams frames for a prompt. Calls onFrame per frame, onDone when the turn
 *  ends. Returns a stop() to close early. */
export function streamPrompt(
  promptId: string,
  onFrame: (seq: number, data: unknown) => void,
  onDone: (status: string) => void,
  fromSeq = 0,
): () => void {
  // fromSeq resumes after frames already loaded (reload-reattach): the SSE endpoint streams only
  // seq > fromSeq. EventSource can't set Last-Event-ID on a fresh connect, so it rides as a query
  // param; auto-reconnects thereafter send Last-Event-ID.
  const es = new EventSource(`${BASE}/prompts/${promptId}/stream${fromSeq ? `?fromSeq=${fromSeq}` : ''}`)
  es.onmessage = (e) => {
    const seq = Number(e.lastEventId) || 0
    try { onFrame(seq, JSON.parse(e.data)) } catch { /* ignore malformed */ }
  }
  es.addEventListener('done', (e) => {
    es.close()
    try { onDone(JSON.parse((e as MessageEvent).data).status) } catch { onDone('completed') }
  })
  es.onerror = () => {
    // Transient drop → EventSource auto-reconnects (readyState CONNECTING). A terminal failure
    // (CLOSED — prompt gone / 4xx, no retry) would leave busy stuck + the stream entry open,
    // blocking reload-reattach — so finish it, freeing the entry for a later reattach.
    if (es.readyState === EventSource.CLOSED) onDone('error')
  }
  return () => es.close()
}
