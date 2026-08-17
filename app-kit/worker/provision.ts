/**
 * Per-user Zooclaw Agent provisioning + config reconciliation (kit backbone). Lazily
 * provisions ONE Managed Agent per user (cached in zooclaw_agents by email), walks the
 * documented bring-up order — create → start (the gateway seeds platform credentials at
 * create) — and then keeps the
 * agent's declared config (persona AGENTS.md + tool_policy) and its skill pin converged
 * with the session's AgentConfig.
 *
 * the ZooClaw API PUTs bump config_version on EVERY call (they are not idempotent in the
 * resource-semantics sense — the API reference → Retry rules), so the kit
 * fingerprints what it applied (`<coreHash>|<skillId>` in the zooclaw_agents row) and
 * only writes actual drift.
 *
 * Takes a Store + ZooclawClient (both injected), so it's unit-testable with a fake client
 * + the in-memory store — only the real the ZooClaw API HTTP needs a live deployment.
 */
import type { Store } from '../server/store.ts'
// TYPE-ONLY (erased — verbatimModuleSyntax). `AgentSource` is a WIRE value: it ships in the
// GET /agent body and the panel renders it, so the API layer declares it and this file, which
// merely decides it, reads it from there.
import type { AgentSource } from '../server/routes.ts'
import { ZooclawError, type ZooclawClient, type AgentResource, type AgentRecord, type Ownership } from '@zooclaw-agents/sdk'
import { AGENT_INSTRUCTION, AGENT_MODEL, buildToolPolicy, type AgentConfig } from '../domain/agent.ts'

/** Platform wiring for provisioning, from Worker env (worker/env.ts). */
export interface ProvisionConfig {
  /** The org anchor for every agent this deployment creates (ZOOCLAW_ORG_ID). */
  orgId: string
  /** Optional Environment to pin at create (omit → the system default ready version). */
  environmentId?: string
  /** FIXED-AGENT MODE (ZOOCLAW_AGENT_ID): use this pre-built agent for everyone and
   *  provision nothing. See `agentFor` for what that skips and why. */
  fixedAgentId?: string
  /** AGENT_PICKER: may a signed-in user bind this deployment to an agent of their own
   *  (agent_bindings)? On by default in the kit; a vertical shipping to end users sets
   *  `AGENT_PICKER=off`, because the API key is ORG-scoped and the picker hands its reach to
   *  whoever can sign in (worker/env.ts agentPickerEnabled). Off ALSO ignores bindings
   *  already stored, so closing it actually revokes the capability instead of
   *  grandfathering it. */
  agentPicker?: boolean
}

export interface ProvisionedAgent {
  agentId: string
  source: AgentSource
  /** THE safety bit. True only for an agent this kit created, and it is the sole licence to
   *  PUT declared config (persona / tool_policy / skill). Every other source is somebody
   *  else's agent — borrowed for chat, never rewritten. `GET /agent` reports this verbatim
   *  as `editable`, so the Config tab and the write gate cannot disagree. */
  managed: boolean
}

/**
 * What resolveAgent found, before any provisioning happens. A UNION, not a flat record, so
 * two invariants hold by type rather than by comment: a borrowed agent always HAS an id (it
 * was named by a pin, a row or an env var), and `managed` is welded to the one source that
 * earns it. `if (!resolved.managed)` therefore narrows `agentId` to `string` on its own.
 */
export type AgentResolution =
  | {
      agentId: string
      source: Exclude<AgentSource, 'per-user'>
      managed: false
      /** Display name, when the source recorded one (bindings capture it at bind time). */
      name?: string | null
    }
  | {
      /** Null before the first turn has created one — the only case where it can be. */
      agentId: string | null
      source: 'per-user'
      managed: true
    }

/**
 * Which agent a turn should use — a PURE LOOKUP: no network, no provisioning, no writes.
 * Shared by the turn path (agentFor), the tool-confirmation path (worker/index.ts) and the
 * panel's "which agent am I on?" route, so all three agree by construction.
 */
export async function resolveAgent(store: Store, email: string, cfg: ProvisionConfig, pinnedAgentId?: string | null): Promise<AgentResolution> {
  // 1. This conversation already has an agent. Nothing may override it: its Zooclaw session
  //    lives on THAT agent, and a follow-up sent elsewhere gets `session not found`.
  if (pinnedAgentId) return { agentId: pinnedAgentId, source: 'conversation', managed: false }
  // 2. The user's own pick. Skipped entirely when the picker is disabled, so flipping
  //    AGENT_PICKER off revokes existing bindings rather than grandfathering them.
  if (cfg.agentPicker) {
    const bound = await store.getAgentBinding(email)
    if (bound) return { agentId: bound.agentId, source: 'binding', managed: false, name: bound.agentName }
  }
  // 3. The deployment-wide fixed agent.
  if (cfg.fixedAgentId) return { agentId: cfg.fixedAgentId, source: 'env-fixed', managed: false }
  // 4. The kit's own per-user agent (null until the first turn provisions it).
  const own = await store.getZooclawAgent(email)
  return { agentId: own?.agentId ?? null, source: 'per-user', managed: true }
}

/** The verified-user → ownership-anchor mapping. the ZooClaw API treats these as opaque data
 *  (NOT auth claims); the kit uses the Access-verified email directly as the owner uid,
 *  prefixed so a shared org's uids are recognizable. */
export function ownershipFor(email: string, orgId: string): Ownership {
  return { owner_uid: `email:${email}`, org_id: orgId }
}

/** Stable, DJB2-ish fingerprint of the CORE declared config (persona + tool toggles).
 *  Not cryptographic — just drift detection so unchanged configs never trigger a
 *  version-bumping PUT. The skill pin is tracked verbatim beside it (see configMark). */
export function hashAgentConfig(config: AgentConfig): string {
  const canon = JSON.stringify({
    p: config.systemPrompt,
    t: Object.keys(config.tools)
      .sort()
      .map((k) => [k, !!config.tools[k]]),
  })
  let h = 5381
  for (let i = 0; i < canon.length; i++) h = ((h << 5) + h + canon.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** The `configHash` column format: `<coreHash>|<appliedSkillId>`. Core and skill are
 *  tracked separately so a failed skill write cannot force the (already-succeeded)
 *  persona/tool PUT to replay every conversation — each replay bumps config_version,
 *  exactly the churn the fingerprint exists to prevent. */
export function configMark(coreHash: string, skillId: string): string {
  return `${coreHash}|${skillId}`
}
function parseMark(mark: string | null): { core: string; skill: string } {
  const i = (mark ?? '').indexOf('|')
  return i < 0 ? { core: mark ?? '', skill: '' } : { core: (mark as string).slice(0, i), skill: (mark as string).slice(i + 1) }
}

/** The declared resource for a FRESH agent. Deterministic per email (no per-session
 *  config) so concurrent first-turns produce byte-identical create bodies — that is what
 *  lets the stable Idempotency-Key converge them to ONE agent instead of 409ing. Session
 *  config is applied as a follow-up PUT (ensureAgentConfig). */
export function createResourceFor(email: string, cfg: ProvisionConfig): AgentResource {
  return {
    name: `app-kit: ${email || 'anon'}`,
    model: { primary: AGENT_MODEL },
    persona: { docs: [{ name: 'AGENTS.md', content: AGENT_INSTRUCTION }] },
    labels: { app: 'zooclaw-app-kit', user: email },
    tool_policy: {},
    sandbox: { scope: 'agent' },
    ...(cfg.environmentId ? { environment_id: cfg.environmentId } : {}),
  }
}

/** The declared sections a config PUT submits (drift only — see hashAgentConfig). */
export function configSections(desired: AgentConfig): Record<string, unknown> {
  return {
    persona: { docs: [{ name: 'AGENTS.md', content: desired.systemPrompt }] },
    tool_policy: buildToolPolicy(desired.tools),
  }
}

/**
 * Idempotently bring the user's agent config to `desired`: compare the recorded
 * fingerprint → write only the drifted half (core PUT and/or skill pin) → record what
 * was actually applied, half by half. The skill pin reconciles both ways: setting a new
 * id installs it (unpinned → follows latest ready), clearing it uninstalls the previous
 * one. Throws on transport failure; the caller treats config as best-effort.
 */
export async function ensureAgentConfig(store: Store, client: ZooclawClient, email: string, agentId: string, desired: AgentConfig): Promise<string[]> {
  const row = await store.getZooclawAgent(email)
  const applied = parseMark(row?.configHash ?? null)
  const wantCore = hashAgentConfig(desired)
  const wantSkill = desired.skillId?.trim() ?? ''
  const changed: string[] = []

  if (applied.core !== wantCore) {
    await client.updateAgent(agentId, configSections(desired))
    changed.push('persona', 'tool_policy')
    applied.core = wantCore
    // Record the core write immediately: if the skill step below fails, the next turn
    // must NOT replay this (config_version-bumping) PUT.
    await store.setZooclawAgentConfig(email, configMark(applied.core, applied.skill))
  }

  if (applied.skill !== wantSkill) {
    if (wantSkill) {
      await client.putAgentSkill(agentId, wantSkill, { enabled: true, versionPin: null })
      changed.push(`skill:${wantSkill}`)
    } else {
      await client.deleteAgentSkill(agentId, applied.skill)
      changed.push(`skill:-${applied.skill}`)
    }
    await store.setZooclawAgentConfig(email, configMark(applied.core, wantSkill))
  }

  return changed
}

/**
 * Create a usable fresh agent, navigating the Idempotency-Key semantics (uniqueness
 * domain (agent.create, key), full-body match — contract Retry rules):
 *
 *  - The stable per-email key converges CONCURRENT first-turns onto one agent.
 *  - But the same key can also REPLAY a create whose agent was since soft-deleted on
 *    the ZooClaw API (replay returns the original — dead — agent_id), and any drift in the
 *    create body (a vertical edited AGENT_INSTRUCTION/AGENT_MODEL, environment added)
 *    turns the replay into 409 idempotency_conflict. Both are permanent without key
 *    rotation, so on either signal we retry ONCE with a unique key. The unique-key path
 *    can race a concurrent first-turn into two agents; the D1 INSERT-OR-IGNORE row is
 *    the tiebreaker and the loser agent is simply never used again.
 */
async function createFreshAgent(client: ZooclawClient, email: string, cfg: ProvisionConfig): Promise<AgentRecord> {
  const body = { resource: createResourceFor(email, cfg), ownership: ownershipFor(email, cfg.orgId) }
  const freshKey = (): string => `zooclaw-app-kit:agent:${email || 'anon'}:${crypto.randomUUID()}`

  let created: AgentRecord
  try {
    created = await client.createAgent(body, `zooclaw-app-kit:agent:${email || 'anon'}`)
  } catch (e) {
    if (e instanceof ZooclawError && e.status === 409 && e.type === 'idempotency_conflict') {
      created = await client.createAgent(body, freshKey())
    } else {
      throw e
    }
  }

  // Platform credentials are seeded by the gateway at create; the kit only starts.
  try {
    await client.startAgent(created.agent_id)
  } catch (e) {
    // 404 here means the "created" agent doesn't exist: the stable key replayed a
    // soft-deleted create. Mint a genuinely new agent under a unique key.
    if (e instanceof ZooclawError && e.status === 404) {
      created = await client.createAgent(body, freshKey())
      await client.startAgent(created.agent_id)
    } else {
      throw e
    }
  }
  return created
}

/**
 * The per-turn entry point: return the ready-to-chat agent for this turn, provisioning on
 * first use.
 *
 * resolveAgent picks the source; what happens next depends entirely on whether the kit owns
 * the agent:
 *
 *   BORROWED (conversation / binding / env-fixed) — used as-is. No create, and
 *     deliberately NO ensureAgentConfig: that agent belongs to a real user, and
 *     PUTting the kit's persona/tool_policy over it would silently rewrite their agent (and
 *     bump config_version on every call). Sessions are still per-conversation, so borrowing
 *     one does not mix conversations. `managed: false` is what the UI reads to disable the
 *     Config tab.
 *
 *   PER-USER — the kit's own agent. Reuse path verifies the cached id still exists on THIS
 *     the ZooClaw API (a 404 → drop the row and re-provision; any other error is rethrown so
 *     a blip never discards a good agent) and re-starts it if it isn't running. Fresh path:
 *     create → start (createFreshAgent). Only here is config applied.
 */
export async function agentFor(
  store: Store,
  client: ZooclawClient,
  email: string,
  cfg: ProvisionConfig,
  config?: AgentConfig,
  opts?: { pinnedAgentId?: string | null },
): Promise<ProvisionedAgent> {
  const resolved = await resolveAgent(store, email, cfg, opts?.pinnedAgentId)
  // The union narrows here: a borrowed agent always has an id, so there is nothing to assert.
  if (!resolved.managed) return { agentId: resolved.agentId, source: resolved.source, managed: false }

  let agentId: string | undefined

  if (resolved.agentId) {
    try {
      const agent = await client.getAgent(resolved.agentId)
      agentId = resolved.agentId
      if (agent.status?.desired_state !== 'running') await client.startAgent(agentId)
    } catch (e) {
      if (e instanceof ZooclawError && e.status === 404) {
        console.log(`[provision] cached agent ${resolved.agentId} not found on this the ZooClaw API — reprovisioning`)
        await store.deleteZooclawAgent(email)
      } else {
        throw e
      }
    }
  }

  if (!agentId) {
    const created = await createFreshAgent(client, email, cfg)
    await store.saveZooclawAgent(email, created.agent_id, null)
    // Re-read so concurrent first-turns converge on the winning (INSERT-OR-IGNORE) row.
    const canonical = await store.getZooclawAgent(email)
    agentId = canonical?.agentId ?? created.agent_id
  }

  // Apply the session's agent config (persona + tool toggles + skill pin). Runs on both
  // reuse and fresh paths so changing settings + starting a new chat re-applies. Drift-
  // gated (configMark) and best-effort: on failure we keep going (the agent falls back
  // to its previous config) rather than failing the turn.
  if (config) {
    try {
      const changed = await ensureAgentConfig(store, client, email, agentId, config)
      if (changed.length) console.log(`[provision] agent config → ${agentId}: ${changed.join(', ')}`)
    } catch (e) {
      console.log(`[provision] ensureAgentConfig failed (non-fatal): ${(e as Error).message}`)
    }
  }

  return { agentId, source: 'per-user', managed: true }
}
