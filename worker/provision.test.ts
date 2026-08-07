/**
 * agentFor / ensureAgentConfig tests with a fake ZooclawClient + the in-memory store —
 * zero quota. Pins the provisioning orchestration the docs make order-sensitive: create
 * (stable Idempotency-Key) → platform credentials → start; cache reuse without touching
 * the ZooClaw API writes; the 404-stale self-heal; start's platform_credentials_required heal;
 * and the drift-gated config PUT (every API PUT bumps config_version, so an
 * unchanged config must produce ZERO PUTs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentFor, ensureAgentConfig, hashAgentConfig, configMark, ownershipFor, type ProvisionConfig } from './provision.ts'
import { createMemStore } from '../server/store-mem.ts'
import { ZooclawError, type ZooclawClient } from '@zooclaw-agents/sdk'
import { AGENT_MODEL, type AgentConfig } from '../domain/agent.ts'

const CFG: ProvisionConfig = { orgId: 'org_1', litellmKey: 'llm_key', userInternalToken: 'uit_key' }

interface FakeOpts {
  /** getAgent's reported status.desired_state (default 'running'). */
  desiredState?: string
  /** Thrown by getAgent (the reuse-path existence probe). */
  getAgentError?: Error
  /** Consumed one per startAgent call — models start failing then succeeding. */
  startErrors?: Error[]
  /** Thrown by updateAgent (the config PUT). */
  updateAgentError?: Error
  /** Consumed one per createAgent call (models idempotency_conflict then success). */
  createErrors?: Error[]
  /** agent_ids returned by successive createAgent calls (default agt-new, agt-new2, …). */
  createIds?: string[]
  /** listCredentials result (default [] — a fresh agent has none). */
  existingCreds?: string[]
  /** Consumed one per putCredential call (models a dead replayed agent 404ing). */
  credErrors?: Error[]
}

/** Call-recording the ZooClaw API double. `calls` is the ordered op log the tests assert on —
 *  order IS the contract (credentials must exist before start; config after bring-up). */
function fakeZooclawApi(opts: FakeOpts = {}) {
  const calls: string[] = []
  const bodies: Record<string, unknown> = {}
  const startErrors = [...(opts.startErrors ?? [])]
  const createErrors = [...(opts.createErrors ?? [])]
  const createIds = [...(opts.createIds ?? ['agt-new', 'agt-new2'])]
  const credErrors = [...(opts.credErrors ?? [])]
  const idemKeys: (string | undefined)[] = []
  const client = {
    async createAgent(input: unknown, key?: string) {
      calls.push('create')
      bodies.create = input
      idemKeys.push(key)
      const e = createErrors.shift()
      if (e) throw e
      return { agent_id: createIds.shift() ?? 'agt-extra' }
    },
    async getAgent(agentId: string) {
      calls.push(`get:${agentId}`)
      if (opts.getAgentError) throw opts.getAgentError
      return { agent_id: agentId, status: { desired_state: opts.desiredState ?? 'running' } }
    },
    async updateAgent(agentId: string, sections: unknown) {
      calls.push('put-config')
      if (opts.updateAgentError) throw opts.updateAgentError
      bodies.sections = sections
      return { agent_id: agentId }
    },
    async listCredentials(_agentId: string) {
      calls.push('list-creds')
      return (opts.existingCreds ?? []).map((app) => ({ app, ref: `pgcred://x/${app}` }))
    },
    async putCredential(_agentId: string, app: string) {
      calls.push(`cred:${app}`)
      const e = credErrors.shift()
      if (e) throw e
    },
    async startAgent() {
      calls.push('start')
      const e = startErrors.shift()
      if (e) throw e
      return { warnings: [] }
    },
    async putAgentSkill(_agentId: string, skillId: string, o?: unknown) {
      calls.push(`skill:${skillId}`)
      bodies.skill = o
      return {}
    },
    async deleteAgentSkill(_agentId: string, skillId: string) {
      calls.push(`unskill:${skillId}`)
    },
  } as unknown as ZooclawClient
  return { client, calls, bodies, idemKeys, idemKey: () => idemKeys[idemKeys.length - 1] }
}

test('fresh path: create (stable idempotency key) → both platform credentials → start → row saved', async () => {
  const store = createMemStore()
  const { client, calls, bodies, idemKey } = fakeZooclawApi()

  const { agentId } = await agentFor(store, client, 'u@x.com', CFG)
  assert.equal(agentId, 'agt-new')
  // credentials RECONCILE (list, then PUT what's missing) — a bring-up retry must not
  // blind-replay a credential that already landed (each PUT appends a secret version)
  assert.deepEqual(calls, ['create', 'list-creds', 'cred:litellm', 'cred:user-internal-token', 'start'])
  // deterministic per email — this is what converges concurrent first-turns to ONE agent
  assert.equal(idemKey(), 'zooclaw-app-kit:agent:u@x.com')

  const create = bodies.create as { resource: Record<string, unknown>; ownership: unknown }
  assert.equal(create.resource.name, 'app-kit: u@x.com')
  assert.deepEqual(create.resource.model, { primary: AGENT_MODEL })
  assert.equal(create.resource.onboarding, false) // chat app: skip the BOOTSTRAP playbook
  assert.equal(create.resource.warm, true)
  assert.deepEqual(create.ownership, ownershipFor('u@x.com', 'org_1'))
  assert.deepEqual(ownershipFor('u@x.com', 'org_1'), { owner_uid: 'email:u@x.com', org_id: 'org_1' })

  assert.deepEqual(await store.getZooclawAgent('u@x.com'), { agentId: 'agt-new', configHash: null })
})

test('reuse path: cached agent exists and desired running → no create / credential / start calls', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls } = fakeZooclawApi({ desiredState: 'running' })

  const { agentId } = await agentFor(store, client, 'u@x.com', CFG)
  assert.equal(agentId, 'agt-1')
  assert.deepEqual(calls, ['get:agt-1']) // probe only — no version-bumping writes
})

test('reuse path: desired_state stopped → startAgent (credentials are NOT rewritten preemptively)', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls } = fakeZooclawApi({ desiredState: 'stopped' })

  await agentFor(store, client, 'u@x.com', CFG)
  assert.deepEqual(calls, ['get:agt-1', 'start']) // credential PUTs append secret versions — heal-only
})

test('stale path: cached agent 404s on this the ZooClaw API → row deleted → fresh create', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-dead', 'stale-hash')
  const { client, calls } = fakeZooclawApi({ getAgentError: new ZooclawError(404, 'not found', 'not_found') })

  const { agentId } = await agentFor(store, client, 'u@x.com', CFG)
  assert.equal(agentId, 'agt-new')
  assert.deepEqual(calls, ['get:agt-dead', 'create', 'list-creds', 'cred:litellm', 'cred:user-internal-token', 'start'])
  // delete-then-save: saveZooclawAgent is INSERT-OR-IGNORE, so the stale row had to go first
  assert.equal((await store.getZooclawAgent('u@x.com'))?.agentId, 'agt-new')
})

test('credential reconcile: an already-landed credential is not re-PUT on bring-up', async () => {
  // Models the retry after a partial bring-up failure: litellm landed, the token PUT
  // timed out. The retry must PUT only the missing app (contract: credential PUTs append
  // secret versions + bump config_version — reconcile, don’t blind-replay).
  const store = createMemStore()
  const { client, calls } = fakeZooclawApi({ existingCreds: ['litellm'] })

  await agentFor(store, client, 'u@x.com', CFG)
  assert.deepEqual(calls, ['create', 'list-creds', 'cred:user-internal-token', 'start'])
})

test('idempotency_conflict on the stable create key → one retry with a fresh unique key', async () => {
  // The stable key replays against a drifted create body (the kit’s defaults changed
  // since the original create) — permanent 409 without rotation.
  const store = createMemStore()
  const { client, calls, idemKeys } = fakeZooclawApi({
    createErrors: [new ZooclawError(409, 'idempotency key reuse', 'idempotency_conflict')],
  })

  const { agentId } = await agentFor(store, client, 'u@x.com', CFG)
  assert.equal(agentId, 'agt-new') // the retry's agent (ids are consumed per SUCCESSFUL create)
  assert.deepEqual(calls.slice(0, 2), ['create', 'create'])
  assert.equal(idemKeys[0], 'zooclaw-app-kit:agent:u@x.com')
  assert.notEqual(idemKeys[1], idemKeys[0]) // rotated
  assert.ok(idemKeys[1]!.startsWith('zooclaw-app-kit:agent:u@x.com:'))
})

test('stable-key replay of a soft-deleted create (bring-up 404s) → recreate under a fresh key', async () => {
  // The replay "succeeds" but returns the original — dead — agent_id; the credential
  // write 404s. Without key rotation this is an unbreakable reprovision loop.
  const store = createMemStore()
  const { client, calls, idemKeys } = fakeZooclawApi({
    createIds: ['agt-dead-replay', 'agt-live'],
    credErrors: [new ZooclawError(404, 'agent not found', 'not_found')],
  })

  const { agentId } = await agentFor(store, client, 'u@x.com', CFG)
  assert.equal(agentId, 'agt-live')
  assert.deepEqual(calls, [
    'create', // stable key → replayed dead agent
    'list-creds',
    'cred:litellm', // 404s → dead replay detected
    'create', // fresh unique key → genuinely new agent
    'list-creds',
    'cred:litellm',
    'cred:user-internal-token',
    'start',
  ])
  assert.notEqual(idemKeys[1], idemKeys[0])
  assert.equal((await store.getZooclawAgent('u@x.com'))?.agentId, 'agt-live')
})

test('a transient (non-404) probe error rethrows and keeps the cached row', async () => {
  // A the ZooClaw API blip must not orphan a good agent: no delete, no re-provision.
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-keep', null)
  const { client, calls } = fakeZooclawApi({ getAgentError: new ZooclawError(500, 'internal', 'internal_error') })

  await assert.rejects(agentFor(store, client, 'u@x.com', CFG), /internal/)
  assert.deepEqual(calls, ['get:agt-keep'])
  assert.equal((await store.getZooclawAgent('u@x.com'))?.agentId, 'agt-keep')
})

test('credential heal: start 409 platform_credentials_required → write credentials → start again', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls } = fakeZooclawApi({
    desiredState: 'stopped',
    startErrors: [new ZooclawError(409, 'platform credentials missing', 'platform_credentials_required')],
  })

  await agentFor(store, client, 'u@x.com', CFG)
  assert.deepEqual(calls, ['get:agt-1', 'start', 'cred:litellm', 'cred:user-internal-token', 'start'])
})

test('credential heal only covers its one documented 409 — other conflicts rethrow', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls } = fakeZooclawApi({
    desiredState: 'stopped',
    startErrors: [new ZooclawError(409, 'environment locked', 'environment_locked')],
  })

  await assert.rejects(agentFor(store, client, 'u@x.com', CFG), /environment locked/)
  assert.deepEqual(calls, ['get:agt-1', 'start']) // no blind credential rewrite
})

test('config drift: PUT sections + record hash; unchanged config → ZERO PUTs; changed prompt → PUT again', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls, bodies } = fakeZooclawApi()
  const config: AgentConfig = { systemPrompt: 'be terse', tools: { web_search: false } }

  const changed = await ensureAgentConfig(store, client, 'u@x.com', 'agt-1', config)
  assert.deepEqual(changed, ['persona', 'tool_policy'])
  assert.deepEqual(bodies.sections, {
    persona: { docs: [{ name: 'AGENTS.md', content: 'be terse' }] },
    tool_policy: { deny: ['web_search'] },
  })
  assert.equal((await store.getZooclawAgent('u@x.com'))?.configHash, configMark(hashAgentConfig(config), ''))

  calls.length = 0
  assert.deepEqual(await ensureAgentConfig(store, client, 'u@x.com', 'agt-1', config), [])
  assert.deepEqual(calls, []) // same fingerprint → no config_version-bumping PUT

  await ensureAgentConfig(store, client, 'u@x.com', 'agt-1', { ...config, systemPrompt: 'be verbose' })
  assert.deepEqual(calls, ['put-config'])
})

test('config drift: skill tracking is independent — clearing the skill uninstalls it without a core re-PUT', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls } = fakeZooclawApi()
  const withSkill: AgentConfig = { systemPrompt: 'p', tools: {}, skillId: 'skl_x' }

  await ensureAgentConfig(store, client, 'u@x.com', 'agt-1', withSkill)
  calls.length = 0

  // Same core config, skill removed → ONLY the uninstall runs (no persona/tool PUT).
  const changed = await ensureAgentConfig(store, client, 'u@x.com', 'agt-1', { systemPrompt: 'p', tools: {} })
  assert.deepEqual(changed, ['skill:-skl_x'])
  assert.deepEqual(calls, ['unskill:skl_x'])
  assert.equal((await store.getZooclawAgent('u@x.com'))?.configHash, configMark(hashAgentConfig(withSkill), ''))
})

test('config drift: a failed skill write must NOT force the (succeeded) core PUT to replay next turn', async () => {
  // Ordering bug guard: the core hash is recorded immediately after the core PUT — a
  // skill-route failure afterwards must not leave the whole mark unrecorded, or every
  // new conversation replays the persona/tool PUT (a config_version bump each time).
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const calls: string[] = []
  const client = {
    async updateAgent() {
      calls.push('put-config')
      return {}
    },
    async putAgentSkill() {
      calls.push('skill')
      throw new ZooclawError(500, 'skill route down', 'internal_error')
    },
  } as unknown as ZooclawClient
  const config: AgentConfig = { systemPrompt: 'p', tools: {}, skillId: 'skl_x' }

  await assert.rejects(ensureAgentConfig(store, client, 'u@x.com', 'agt-1', config), /skill route down/)
  assert.deepEqual(calls, ['put-config', 'skill'])
  // Core hash recorded, skill not — the retry re-attempts ONLY the skill install.
  assert.equal((await store.getZooclawAgent('u@x.com'))?.configHash, configMark(hashAgentConfig(config), ''))
  calls.length = 0
  await assert.rejects(ensureAgentConfig(store, client, 'u@x.com', 'agt-1', config), /skill route down/)
  assert.deepEqual(calls, ['skill']) // no core re-PUT
})

test('config drift: a skillId pins the skill on the agent (unpinned → follow latest ready)', async () => {
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client, calls, bodies } = fakeZooclawApi()

  const changed = await ensureAgentConfig(store, client, 'u@x.com', 'agt-1', { systemPrompt: 'p', tools: {}, skillId: 'skl_x' })
  assert.deepEqual(changed, ['persona', 'tool_policy', 'skill:skl_x'])
  assert.deepEqual(calls, ['put-config', 'skill:skl_x'])
  assert.deepEqual(bodies.skill, { enabled: true, versionPin: null })
})

test('agentFor: a config PUT failure is non-fatal and leaves the fingerprint unrecorded', async () => {
  // The turn must not fail because config application blipped — the agent just keeps its
  // previous config, and the unrecorded hash forces a retry next turn.
  const store = createMemStore()
  await store.saveZooclawAgent('u@x.com', 'agt-1', null)
  const { client } = fakeZooclawApi({ updateAgentError: new Error('the ZooClaw API down') })

  const { agentId } = await agentFor(store, client, 'u@x.com', CFG, { systemPrompt: 'p', tools: {} })
  assert.equal(agentId, 'agt-1')
  assert.equal((await store.getZooclawAgent('u@x.com'))?.configHash, null)
})

test('hashAgentConfig: stable under tools key order; the skill pin is NOT part of the core hash', () => {
  const base: AgentConfig = { systemPrompt: 'p', tools: { a: true, b: false } }
  const h = hashAgentConfig(base)
  assert.equal(hashAgentConfig({ systemPrompt: 'p', tools: { b: false, a: true } }), h)
  // skills are tracked verbatim in the composite mark (configMark), so the core hash
  // ignores them — a skill change must not force a persona/tool re-PUT
  assert.equal(hashAgentConfig({ ...base, skillId: 'skl_x' }), h)
})

test('hashAgentConfig + configMark: prompt, tool state, and skill pin all move the composite mark', () => {
  const base: AgentConfig = { systemPrompt: 'p', tools: { a: true, b: false } }
  const mark = (c: AgentConfig): string => configMark(hashAgentConfig(c), c.skillId?.trim() ?? '')
  const m = mark(base)
  assert.notEqual(mark({ ...base, systemPrompt: 'q' }), m)
  assert.notEqual(mark({ ...base, tools: { a: false, b: false } }), m)
  assert.notEqual(mark({ ...base, skillId: 'skl_x' }), m)
  assert.equal(mark({ ...base, skillId: '   ' }), m) // whitespace skill = absent
})
