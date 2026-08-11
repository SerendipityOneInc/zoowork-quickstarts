/**
 * Storage contract. The whole app talks to this async `Store` interface and never
 * to a concrete database — so the driver swaps freely (switch the DB per scenario).
 * It is ASYNC because the production targets are async: Cloudflare D1 (primary deploy
 * + local dev via `wrangler dev`), Postgres (AWS RDS), MySQL (GCP Cloud SQL). Add a
 * `store-<driver>.ts` and call sites don't change.
 *
 * Three tables model the turn lifecycle:
 *   tasks   — one conversation (keyed to a Zooclaw session id once created)
 *   prompts — one agent turn within a task
 *   frames  — one stream-json line of agent output, ordered by seq
 *
 * `frames` is the streaming source of truth (streaming-experience-contract I0): both the
 * live tail and the refresh rebuild read frames from here, never from the API. Keeping
 * that contract in one swappable seam is why streaming is *not* welded to any runtime.
 */
export interface Task {
  id: string
  project_id: string
  status: string
  /** The Zooclaw session backing this conversation (null until the first turn creates it). */
  session_id: string | null
  /** The Zooclaw agent this conversation is PINNED to, written when its first turn resolves
   *  one (null for conversations that predate the column). Sessions are agent-scoped, so
   *  rebinding must not move an existing conversation to a different agent — its session id
   *  would not exist there. See migrations/0002. */
  agent_id: string | null
  user_email: string | null
  created_at: string
}

/** Lightweight conversation row for the per-user session list (sidebar). */
export interface TaskSummary {
  id: string
  status: string
  created_at: string
  title: string
}

/** A user's provisioned Zooclaw Agent (zooclaw_agents row). `configHash` fingerprints the
 *  last agent config (persona + tool policy + skill pin) this kit applied, driving the
 *  "config changed → PUT the drift" check WITHOUT gratuitous PUTs (every API PUT
 *  bumps config_version even when nothing changed — see the API reference). */
export interface ZooclawAgentRow {
  agentId: string
  configHash: string | null
}

/** A user's manually BOUND agent (agent_bindings row) — one they already own in the ZooClaw
 *  app, borrowed by this deployment. Distinct from ZooclawAgentRow on purpose: this agent
 *  belongs to its author, so the kit only ever reads it. Nothing here is drift-gated
 *  because nothing here is ever written upstream (worker/provision.ts). */
export interface AgentBindingRow {
  agentId: string
  /** Display name captured when the binding was saved (may be stale, may be null). */
  agentName: string | null
}
export interface Prompt {
  id: string
  task_id: string
  prompt: string
  status: string
  created_at: string
  completed_at: string | null
}
export interface Frame {
  seq: number
  data: unknown
}

/** A prompt's display attachment (metadata only; the WebP rendition BLOBs are fetched
 *  separately by the authed serve route, keyed by fileId). NOTE: the upload path ships
 *  DISABLED (Zooclaw Files is not production-wired) — the display plumbing stays so a
 *  vertical can re-enable it when the platform lands shared workspaces. */
export interface AttachmentMeta {
  fileId: string
  filename: string
  contentType: string
}

export interface Store {
  createTask(id: string, projectId: string, userEmail: string): Promise<void>
  getTask(id: string): Promise<Task | undefined>
  listTasksByUser(userEmail: string): Promise<TaskSummary[]>
  setTaskStatus(id: string, status: string): Promise<void>
  setTaskSessionId(id: string, sessionId: string): Promise<void>
  /** Pin this conversation to the agent its first turn resolved. Write-once in practice —
   *  every later turn reads the pin instead of re-resolving. */
  setTaskAgentId(id: string, agentId: string): Promise<void>

  /** The user's manually bound agent, if they picked one (see AgentBindingRow). */
  getAgentBinding(userEmail: string): Promise<AgentBindingRow | undefined>
  /** Upsert the binding (last write wins — unlike saveZooclawAgent, rebinding is the point). */
  saveAgentBinding(userEmail: string, agentId: string, agentName: string | null): Promise<void>
  /** Drop the binding → the next new conversation falls back to env-fixed or per-user. */
  deleteAgentBinding(userEmail: string): Promise<void>

  getZooclawAgent(userEmail: string): Promise<ZooclawAgentRow | undefined>
  /** Idempotent (INSERT OR IGNORE): first writer per email wins, losers no-op. */
  saveZooclawAgent(userEmail: string, agentId: string, configHash: string | null): Promise<void>
  /** Record the config fingerprint just applied to the user's agent. */
  setZooclawAgentConfig(userEmail: string, configHash: string): Promise<void>
  /** Forget a user's cached agent so the next turn re-provisions. Used when the cached
   *  agent no longer exists on the configured the ZooClaw API (it 404s) — a row left over from a
   *  different environment/token names an id this the ZooClaw API can't see. Required because
   *  saveZooclawAgent is INSERT-OR-IGNORE (email is the PK), so it cannot overwrite a
   *  stale row; the row must be deleted first. */
  deleteZooclawAgent(userEmail: string): Promise<void>

  createPrompt(id: string, taskId: string, prompt: string): Promise<void>
  getPrompt(id: string): Promise<Prompt | undefined>
  listPrompts(taskId: string): Promise<Prompt[]>
  /** Set status only while still 'running' (sets completed_at). */
  finishPrompt(id: string, status: string): Promise<void>
  /** Unconditional status write (unlike finishPrompt's running-only guard) — used by R3
   *  self-heal to flip a prematurely-failed prompt back to 'completed'. */
  setPromptStatus(id: string, status: string): Promise<void>

  appendFrame(promptId: string, seq: number, data: unknown): Promise<void>
  /** Frames with seq strictly greater than `fromSeq`, ordered by seq — the resumable
   *  read both the live tail and reload-reattach use (streaming-experience-contract I1/I3). */
  framesSince(promptId: string, fromSeq: number): Promise<Frame[]>

  // ── image attachments (display channel; see migrations/0001) ──────────────
  /** Persist a file's display renditions (WebP BLOBs), keyed by an opaque file id.
   *  Idempotent (INSERT OR REPLACE). Non-image files pass null blobs (chip-only). */
  saveAttachment(
    fileId: string,
    userEmail: string,
    filename: string,
    contentType: string,
    thumb: ArrayBuffer | null,
    large: ArrayBuffer | null,
  ): Promise<void>
  /** One rendition's bytes + owner email, for the authed serve route (undefined if absent). */
  getAttachment(fileId: string, size: 'thumb' | 'large'): Promise<{ userEmail: string; bytes: ArrayBuffer } | undefined>
  /** Associate an ordered list of uploaded file ids with a prompt (for bubble display). */
  linkPromptFiles(promptId: string, fileIds: string[]): Promise<void>
  /** A prompt's attachments (metadata only), ordered as sent. */
  listPromptAttachments(promptId: string): Promise<AttachmentMeta[]>
}
