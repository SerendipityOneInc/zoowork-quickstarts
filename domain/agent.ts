/**
 * domain/agent.ts — the BACKEND business seam (Worker side), plus the demo's settings model.
 *
 * What a vertical edits here, all React/DOM-free (this file bundles into the Worker AND
 * is imported by the frontend settings panel):
 *
 *   1. AGENT_INSTRUCTION — the DEFAULT persona. The kit writes it as the agent's
 *      `AGENTS.md` persona doc (the ZooClaw API upserts it into agent_docs; the worker assembles
 *      it into the prompt). It is the initial value of the editable "system prompt" field
 *      in the UI; whatever the UI sends wins per session (applied as a PUT when changed).
 *
 *   2. TOOLS — which OpenClaw tools the UI exposes as on/off toggles. Each maps a stable
 *      UI `key` to the OpenClaw tool name used in the agent's `tool_policy`. The kit
 *      builds the policy with buildToolPolicy() below (see its [verify] note).
 *
 *   3. AGENT_MODEL / SKILLS — the model alias and any skill pins baked into the agent at
 *      create (see worker/provision.ts).
 *
 * Config is applied per-user-agent via `PUT /v1/agents/{id}` — which bumps
 * config_version on EVERY call — so the kit fingerprints the desired config
 * (hashAgentConfig in worker/provision.ts) and only PUTs actual drift.
 */
export const AGENT_INSTRUCTION = 'You are a helpful AI assistant. Answer clearly and concisely, in the language the user writes to you in.'

/** The model alias baked into new agents (a stable `litellm/...` alias from GET /v1/models;
 *  the platform default). Change per vertical, or extend AgentConfig to make it per-user. */
export const AGENT_MODEL = 'litellm/claude-sonnet-5'

/**
 * Attachments ship DISABLED: Zooclaw's Files API is a text-content JSON contract and is
 * marked *Not production-wired* (no shared workspace yet), so there is nowhere to stage
 * binary uploads. The display plumbing (store + bubble rendering) stays intact — flip
 * this on and implement RouteVars.uploadFile when the platform lands file staging.
 */
export const ATTACHMENTS_ENABLED = false

/** Hard ceiling for ONE uploaded attachment, enforced on BOTH sides when attachments are
 *  enabled: the Composer rejects an oversize file before it touches the wire, and
 *  POST /api/app/files rejects it again (413). 30 MB. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

/** An OpenClaw tool the UI can toggle. */
export interface ToolToggle {
  /** Stable key used in the wire payload + UI state. */
  key: string
  /** Shown in the settings panel. */
  label: string
  /** One-line help under the toggle. */
  description: string
  /** The OpenClaw tool name this toggle controls in the agent's tool_policy. Must match
   *  the worker's tool manifest vocabulary, or the toggle silently no-ops. */
  toolName: string
  /** Default state for a fresh session. */
  defaultOn: boolean
}

/** The tools exposed as toggles. Names follow the docs' tool_policy example vocabulary
 *  (`{"allow":["read","web_search"]}`); extend with your deployment's manifest names. */
export const TOOLS: ToolToggle[] = [
  {
    key: 'web_search',
    label: 'Web search',
    description: 'Let the agent use web_search to look things up and browse. Turned off, it works from what it already knows plus the tools it has loaded.',
    toolName: 'web_search',
    defaultOn: true,
  },
]

/**
 * Build the agent's `tool_policy` from the UI toggles. the ZooClaw API semantics: `{}` means the
 * FULL tool manifest; a non-empty object is interpreted as an OpenClaw allow/deny policy.
 * All toggles on → `{}` (full manifest). Any toggle off → `{ deny: [names...] }` so every
 * un-toggled tool keeps working. [verify] the deny-key spelling against the OpenClaw
 * policy schema before shipping a vertical that relies on it.
 */
export function buildToolPolicy(tools: Record<string, boolean>, registry: ToolToggle[] = TOOLS): Record<string, unknown> {
  const denied = registry.filter((t) => (tools[t.key] ?? t.defaultOn) === false).map((t) => t.toolName)
  return denied.length ? { deny: denied } : {}
}

/**
 * Placeholder shown in the settings panel's "Skill" field, and the shape a skill pin takes.
 *
 * Zooclaw skills are REGISTRY resources (`skl_...` ids with ready versions), not git URLs:
 * upload/publish happens through platform tooling (POST /v1/skills + versions), and an
 * agent *pins* a skill by id. The user pastes a `skl_...` id; the kit installs it on the
 * user's agent via `PUT /v1/agents/{agent_id}/skills/{skill_id}` (unpinned → follows
 * latest ready version automatically). Empty = no skill installed.
 */
export const SKILL_ID_PLACEHOLDER = 'skl_...'

/** The per-agent config the UI edits and the kit applies to the user's Zooclaw agent.
 *  `tools` maps a ToolToggle.key → enabled. */
export interface AgentConfig {
  systemPrompt: string
  tools: Record<string, boolean>
  /** A Zooclaw skill registry id (see SKILL_ID_PLACEHOLDER) installed on the user's agent
   *  (unpinned, follows latest). Optional — empty/absent installs no skill. */
  skillId?: string
}

/** The default config a fresh session starts from (UI seeds its panel with this). */
export function defaultAgentConfig(): AgentConfig {
  return {
    systemPrompt: AGENT_INSTRUCTION,
    tools: Object.fromEntries(TOOLS.map((t) => [t.key, t.defaultOn])),
    skillId: '',
  }
}

/**
 * When a turn carries uploaded files (attachments enabled), this suffix is appended to
 * the prompt SENT TO THE AGENT — never shown in the UI — pointing it at the staged
 * workspace paths. Returns '' when there are no files. Customize the wording per app.
 */
export function attachmentPromptSuffix(files: { filename: string }[]): string {
  if (!files.length) return ''
  const paths = files.map((f) => `/workspace/uploads/${f.filename}`).join(', ')
  return `\n\n[note] The user attached ${paths}. Read them before answering.`
}
