/**
 * Per-user Zooclaw Agent provisioning + config reconciliation (kit backbone). Lazily
 * provisions ONE Managed Agent per user (cached in zooclaw_agents by email), walks the
 * documented bring-up order — create → platform credentials → start — and then keeps the
 * agent's declared config (persona AGENTS.md + tool_policy) and its skill pin converged
 * with the session's AgentConfig.
 *
 * the ZooClaw API PUTs bump config_version on EVERY call (they are not idempotent in the
 * resource-semantics sense — the API reference → Retry rules), so the kit
 * fingerprints what it applied (`<coreHash>|<skillId>` in the zooclaw_agents row) and
 * only writes actual drift. Credential PUTs additionally append a secret version per
 * call, so bring-up RECONCILES against the credential list instead of blind-PUTting.
 *
 * Takes a Store + ZooclawClient (both injected), so it's unit-testable with a fake client
 * + the in-memory store — only the real the ZooClaw API HTTP needs a live deployment.
 */
import type { Store } from '../server/store.ts'
import { ZooclawError, type ZooclawClient, type AgentResource, type AgentRecord, type Ownership } from '@zooclaw-agents/sdk'
import { AGENT_INSTRUCTION, AGENT_MODEL, buildToolPolicy, type AgentConfig } from '../domain/agent.ts'

/** Platform wiring for provisioning, from Worker env (worker/env.ts). */
export interface ProvisionConfig {
  /** The org anchor for every agent this deployment creates (ZOOCLAW_ORG_ID). */
  orgId: string
  /** INTERNAL MODE ONLY. LiteLLM key written as the agent's `litellm` platform
   *  credential. Unused (and unobtainable) in gateway mode - see gatewaySeedsCredentials. */
  litellmKey?: string
  /** INTERNAL MODE ONLY. Token written as the agent's `user-internal-token` platform
   *  credential. Unused in gateway mode - see gatewaySeedsCredentials. */
  userInternalToken?: string
  /** Optional Environment to pin at create (omit → the system default ready version). */
  environmentId?: string
  /** FIXED-AGENT MODE (ZOOCLAW_AGENT_ID): use this pre-built agent for everyone and
   *  provision nothing. See `agentFor` for what that skips and why. */
  fixedAgentId?: string
  /** GATEWAY MODE: the public `/service/v1` gateway seeds both platform credentials
   *  itself on a successful create, and blocks `credentials/*` with a 404. So the kit
   *  must NOT write them — the litellmKey/userInternalToken above are unused, and an
   *  external developer could not obtain them anyway. Verified on staging 2026-08-06:
   *  the gateway seeds but does NOT start, so `start` below is still the kit's job. */
  gatewaySeedsCredentials?: boolean
}

export interface ProvisionedAgent {
  agentId: string
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
    // Skip the BOOTSTRAP onboarding playbook: a chat app wants the configured persona
    // applied, not a first turn that interviews the user to write its own.
    onboarding: false,
    // Pre-warm the sandbox so the first message doesn't pay the cold-start.
    warm: true,
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

/** Reconcile the two REQUIRED platform credentials: list what exists, PUT only what's
 *  missing (each PUT appends a secret version + bumps config_version, so a bring-up
 *  retry must not blind-replay a credential that already landed — contract Retry rules).
 *  `force` re-PUTs both regardless: used for the explicit platform_credentials_required
 *  heal, where existence evidently wasn't sufficient. */
async function reconcilePlatformCredentials(client: ZooclawClient, agentId: string, cfg: ProvisionConfig, force = false): Promise<void> {
  if (cfg.gatewaySeedsCredentials) return // gateway owns this and 404s the routes
  const have = force ? new Set<string>() : new Set((await client.listCredentials(agentId)).map((c) => c.app))
  if (!cfg.litellmKey || !cfg.userInternalToken) {
    throw new Error(
      'Internal provisioning needs ZOOCLAW_LITELLM_KEY and ZOOCLAW_USER_INTERNAL_TOKEN. ' +
        'Use ZOOCLAW_API_KEY (gateway mode) instead - the gateway seeds both for you.',
    )
  }
  if (!have.has('litellm')) await client.putCredential(agentId, 'litellm', { api_key: cfg.litellmKey })
  if (!have.has('user-internal-token')) await client.putCredential(agentId, 'user-internal-token', { token: cfg.userInternalToken })
}

/** Start the agent, self-healing the one documented start failure: 409
 *  platform_credentials_required → force-write both platform credentials → start again. */
async function startWithCredentialHeal(client: ZooclawClient, agentId: string, cfg: ProvisionConfig): Promise<void> {
  try {
    await client.startAgent(agentId)
  } catch (e) {
    if (e instanceof ZooclawError && e.status === 409 && e.type === 'platform_credentials_required') {
      // In gateway mode this heal cannot work (the credential routes are 404) — and it
      // should never fire, since the gateway seeded them at create. Surface it instead of
      // silently retrying a start that will fail the same way.
      if (cfg.gatewaySeedsCredentials) throw e
      await reconcilePlatformCredentials(client, agentId, cfg, true)
      await client.startAgent(agentId)
      return
    }
    throw e
  }
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

  try {
    await reconcilePlatformCredentials(client, created.agent_id, cfg)
    await startWithCredentialHeal(client, created.agent_id, cfg)
  } catch (e) {
    // 404 here means the "created" agent doesn't exist: the stable key replayed a
    // soft-deleted create. Mint a genuinely new agent under a unique key.
    if (e instanceof ZooclawError && e.status === 404) {
      created = await client.createAgent(body, freshKey())
      await reconcilePlatformCredentials(client, created.agent_id, cfg)
      await startWithCredentialHeal(client, created.agent_id, cfg)
    } else {
      throw e
    }
  }
  return created
}

/**
 * The per-turn entry point: return the user's ready-to-chat agent id, provisioning on
 * first use. Reuse path verifies the cached id still exists on THIS the ZooClaw API (a 404 →
 * drop the row and re-provision; any other error is rethrown so a blip never discards a
 * good agent) and re-starts it if it isn't running. Fresh path: create → credentials →
 * start (createFreshAgent).
 */
export async function agentFor(store: Store, client: ZooclawClient, email: string, cfg: ProvisionConfig, config?: AgentConfig): Promise<ProvisionedAgent> {
  // FIXED-AGENT MODE: a pre-built agent from the ZooClaw app, borrowed as-is. Nothing here
  // is provisioning — no create, no credential writes, and deliberately NO ensureAgentConfig
  // below: that agent belongs to a real user, and PUTting the kit's persona/tool_policy
  // over it would silently rewrite their agent (and bump config_version on every call).
  // Sessions are still per-conversation, so borrowing it does not mix conversations.
  if (cfg.fixedAgentId) return { agentId: cfg.fixedAgentId }

  let agentId: string | undefined

  const existing = await store.getZooclawAgent(email)
  if (existing?.agentId) {
    try {
      const agent = await client.getAgent(existing.agentId)
      agentId = existing.agentId
      if (agent.status?.desired_state !== 'running') await startWithCredentialHeal(client, agentId, cfg)
    } catch (e) {
      if (e instanceof ZooclawError && e.status === 404) {
        console.log(`[provision] cached agent ${existing.agentId} not found on this the ZooClaw API — reprovisioning`)
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

  return { agentId }
}
