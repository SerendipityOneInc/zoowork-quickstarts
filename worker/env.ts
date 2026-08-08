/**
 * Worker runtime bindings (see wrangler.jsonc). Shared by the Worker entry and the
 * Durable Object. The the ZooClaw API service token + the two platform credentials are the only
 * secrets the backbone needs; auth is Cloudflare Access by default (a vertical can swap
 * to its own IdP / iframe handoff in worker/auth.ts).
 *
 * SECURITY: ZOOCLAW_API_KEY authenticates this Worker as your whole organization. It must
 * never be sent to the browser, logged, or embedded in a client bundle.
 */
import { createZooclawClient, DEFAULT_BASE_URL, type ZooclawClient } from '@zooclaw-agents/sdk'
import { ATTACHMENTS_ENABLED } from '../domain/agent.ts'
import type { RuntimeConfig } from '../server/routes.ts'

export interface Env {
  /** D1 database (tasks/prompts/frames + zooclaw_agents). */
  DB: D1Database
  /** Durable Object namespace for the per-task turn runner. */
  TASK_DO: DurableObjectNamespace<import('./task-do.ts').TaskDO>
  /** Static SPA assets (the vite build/). */
  ASSETS: Fetcher

  // ── Zooclaw API: pick ONE of the two auth modes below ────────────────────
  //
  // PUBLIC PATH (preferred). The claw-interface gateway authenticates an org service
  // token (`zct_…`), enforces tenancy, and proxies to the ZooClaw API. Publicly reachable — no
  // tunnel. This is what a customer deployment uses.
  /** Optional gateway base override. The SDK defaults to the public gateway, so leave
   *  this unset unless you are targeting a different deployment. */
  ZOOCLAW_API_URL?: string
  /** Org service token, `zct_…` (secret: `wrangler secret put ZOOCLAW_API_KEY`). */
  ZOOCLAW_API_KEY?: string
  /**
   * Org anchor stamped on agents this deployment creates (`ownership.org_id`).
   *
   * INTERNAL MODE ONLY in practice: the gateway overwrites `ownership` with the tenant
   * bound to your API key, so whatever you send is discarded (verified on staging - a
   * create sent `probe-org` and came back with the key's real org). Leave it unset in
   * gateway mode.
   */
  ZOOCLAW_ORG_ID?: string
  /** INTERNAL MODE ONLY. LiteLLM key written as each agent's `litellm` platform
   *  credential. In gateway mode the gateway seeds this and the kit never writes it. */
  ZOOCLAW_LITELLM_KEY?: string
  /** INTERNAL MODE ONLY. Token written as each agent's `user-internal-token` credential.
   *  In gateway mode the gateway seeds this and the kit never writes it. */
  ZOOCLAW_USER_INTERNAL_TOKEN?: string
  /** Optional Environment id to pin at agent create (omit → system default). */
  ZOOCLAW_ENVIRONMENT_ID?: string
  /**
   * FIXED-AGENT MODE. When set, every user of this deployment talks to THIS pre-built
   * agent and the kit provisions nothing — no create, no platform credentials, no config
   * PUT (see worker/provision.ts). That is the only way to run without
   * ZOOCLAW_LITELLM_KEY / ZOOCLAW_USER_INTERNAL_TOKEN, which are per-user credentials an
   * external developer cannot mint: an agent built in the ZooClaw app already has them.
   *
   * It is a DEMO/single-tenant mode, not a multi-tenant one — everyone shares one agent's
   * config (each conversation still gets its own isolated session, so they don't share
   * memory). Leave unset for the real per-user provisioning path.
   */
  ZOOCLAW_AGENT_ID?: string

  /** Optional shared embed gate key. When set, every /api/app/* call must present it
   *  (X-Embed-Key header or ?k= query) or gets 401. Unset → gate disabled. */
  EMBED_KEY?: string

  // ── Cloudflare Access (the default IdP gateway) ──────────────────────────
  /** Access team domain, e.g. `myteam.cloudflareaccess.com` (the JWT issuer). */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** The Access application's AUD tag — the JWT audience to require. */
  CF_ACCESS_AUD?: string
  /** Local-dev only (.dev.vars): bypass Access and act as this email. Never set in prod. */
  DEV_EMAIL?: string
}

/** True when this deployment talks to the public gateway rather than the ZooClaw API directly.
 *  Gateway mode changes ONE behavior beyond auth: the gateway owns credential injection
 *  and blocks `credentials/*` (404), so provisioning must not write them (provision.ts). */
export function isGatewayMode(env: Env): boolean {
  return !!env.ZOOCLAW_API_KEY
}

/**
 * Every `Env` key a deployer actually sets. The three Worker bindings (DB / TASK_DO /
 * ASSETS) are excluded: they are wrangler wiring, not knobs a deployer turns.
 */
export type ConfigurableEnvKey = Exclude<keyof Env, 'DB' | 'TASK_DO' | 'ASSETS'>

/**
 * One declared row per configurable variable in `Env` above — the single source the kit
 * uses to TELL the user what they can set. `GET /api/app/config` renders this list as
 * presence-only status (see describeRuntime), and the Debug panel's Config tab renders
 * that.
 *
 * Adding a variable to `Env` means adding it to KIT_ENV_VAR_DOCS too, and the compiler
 * enforces that rather than trusting the convention: the docs table is a
 * `Record<ConfigurableEnvKey, …>`, so an undeclared variable is a typecheck failure, not a
 * silently uncovered one. That matters because server/routes.test.ts derives its leak
 * sentinels from this list — a variable missing here would have had NO leak coverage at all.
 */
export interface EnvVarDoc {
  /** The variable name, exactly as it appears in .dev.vars / wrangler.jsonc. */
  name: ConfigurableEnvKey
  /** One line: what changes when it is set, and where that lands in the ZooClaw API. */
  effect: string
  /** True when the value is (or carries) a credential — `wrangler secret put`, never
   *  wrangler.jsonc. The kit reports these as presence only; see describeRuntime. */
  secret: boolean
}

/** The source of truth. Exhaustive over ConfigurableEnvKey by construction — omit a key
 *  and `tsc` fails here; invent one that is not in `Env` and it fails here too. */
const KIT_ENV_VAR_DOCS: Record<ConfigurableEnvKey, Omit<EnvVarDoc, 'name'>> = {
  ZOOCLAW_API_KEY: {
    effect: 'Org service token. Rides as the Bearer on every ZooClaw API call; its presence selects gateway mode.',
    secret: true,
  },
  ZOOCLAW_API_URL: {
    effect: 'Base URL for every ZooClaw API call. Unset, the SDK targets the public gateway.',
    secret: false,
  },
  ZOOCLAW_ORG_ID: {
    effect: 'ownership.org_id on created agents. Discarded in gateway mode — the gateway substitutes the key’s own tenant.',
    secret: false,
  },
  ZOOCLAW_LITELLM_KEY: {
    effect: 'Internal mode only: written as the agent’s `litellm` platform credential. Unused in gateway mode (credentials/* is 404).',
    secret: true,
  },
  ZOOCLAW_USER_INTERNAL_TOKEN: {
    effect: 'Internal mode only: written as the agent’s `user-internal-token` credential. Unused in gateway mode.',
    secret: true,
  },
  ZOOCLAW_ENVIRONMENT_ID: {
    effect: 'resource.environment_id at agent create. The pin locks after the first sandbox — later changes return 409 environment_locked.',
    secret: false,
  },
  ZOOCLAW_AGENT_ID: {
    effect: 'Fixed-agent mode: everyone talks to this agent and the kit provisions nothing — no create, no config PUT.',
    secret: false,
  },
  EMBED_KEY: {
    effect: 'Shared embed gate. Set, every /api/app/* call must present it (X-Embed-Key header or ?k=) or gets 401.',
    secret: true,
  },
  CF_ACCESS_TEAM_DOMAIN: {
    effect: 'Cloudflare Access team domain — the JWT issuer the Worker verifies each request against.',
    secret: false,
  },
  CF_ACCESS_AUD: {
    effect: 'The Access application’s AUD tag — the JWT audience the Worker requires.',
    secret: false,
  },
  DEV_EMAIL: {
    effect: 'Local dev only: bypasses Access and acts as this email (the tenant key everything is stored under).',
    secret: false,
  },
}

export const KIT_ENV_VARS: EnvVarDoc[] = (Object.keys(KIT_ENV_VAR_DOCS) as ConfigurableEnvKey[]).map((name) => ({
  name,
  ...KIT_ENV_VAR_DOCS[name],
}))

/** Is a declared variable present? Reads by name off Env — every declared row is a string
 *  var, so a non-string binding can never be mistaken for one. */
function isConfigured(env: Env, name: ConfigurableEnvKey): boolean {
  const v = (env as unknown as Record<string, unknown>)[name]
  return typeof v === 'string' && v.length > 0
}

/**
 * The non-secret description of THIS deployment, served by `GET /api/app/config`.
 *
 * SECURITY: variable VALUES never appear in the result — every declared variable is
 * reduced to `configured: true | false`. ZOOCLAW_API_KEY authenticates the Worker as the
 * whole organization, so a leak here is a tenant-wide compromise; the one value that does
 * cross the wire is the resolved API base URL, which is a public endpoint and the single
 * thing a user cannot otherwise tell about their deployment. server/routes.test.ts locks
 * both halves of that rule.
 */
export function describeRuntime(env: Env): RuntimeConfig {
  return {
    runtime: {
      // The kit builds a client only from ZOOCLAW_API_KEY (see zooclawClient), so gateway
      // is the only reachable transport; without the key nothing can talk to the API at all.
      transport: isGatewayMode(env) ? 'gateway' : 'unconfigured',
      provisioning: env.ZOOCLAW_AGENT_ID ? 'fixed-agent' : 'per-user',
      identity: env.DEV_EMAIL ? 'dev-email' : env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD ? 'cloudflare-access' : 'unconfigured',
      embedGate: !!env.EMBED_KEY,
      attachments: ATTACHMENTS_ENABLED,
      apiBaseUrl: env.ZOOCLAW_API_URL || DEFAULT_BASE_URL,
      apiBaseUrlFrom: env.ZOOCLAW_API_URL ? 'ZOOCLAW_API_URL' : 'sdk-default',
    },
    env: KIT_ENV_VARS.map((v) => ({ name: v.name, effect: v.effect, secret: v.secret, configured: isConfigured(env, v.name) })),
  }
}

/** The provisioning slice of Env, in the shape worker/provision.ts wants. */
export function provisionConfig(env: Env): import('./provision.ts').ProvisionConfig {
  return {
    // Ignored in gateway mode; the gateway substitutes the API key's own tenant.
    orgId: env.ZOOCLAW_ORG_ID ?? 'gateway-assigned',
    litellmKey: env.ZOOCLAW_LITELLM_KEY,
    userInternalToken: env.ZOOCLAW_USER_INTERNAL_TOKEN,
    gatewaySeedsCredentials: isGatewayMode(env),
    ...(env.ZOOCLAW_ENVIRONMENT_ID ? { environmentId: env.ZOOCLAW_ENVIRONMENT_ID } : {}),
    ...(env.ZOOCLAW_AGENT_ID ? { fixedAgentId: env.ZOOCLAW_AGENT_ID } : {}),
  }
}

/**
 * The one place the kit constructs an SDK client, and the one place the two auth modes
 * differ. The SDK's `ZooclawAuth` is a union, so nothing downstream of here knows which
 * mode is in play — swapping modes is this function and the env, nothing else.
 */
export function zooclawClient(env: Env): ZooclawClient {
  if (env.ZOOCLAW_API_KEY) {
    // ZOOCLAW_API_URL is optional: the SDK already defaults to the public gateway. Set it
    // only to target a different deployment.
    return createZooclawClient({
      apiKey: env.ZOOCLAW_API_KEY,
      ...(env.ZOOCLAW_API_URL ? { baseUrl: env.ZOOCLAW_API_URL } : {}),
    })
  }
  throw new Error('ZOOCLAW_API_KEY is required. Put your organization API key (zct_...) in .dev.vars, or set it with `wrangler secret put ZOOCLAW_API_KEY`.')
}
