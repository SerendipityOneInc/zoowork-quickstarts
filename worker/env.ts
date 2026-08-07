/**
 * Worker runtime bindings (see wrangler.jsonc). Shared by the Worker entry and the
 * Durable Object. The the ZooClaw API service token + the two platform credentials are the only
 * secrets the backbone needs; auth is Cloudflare Access by default (a vertical can swap
 * to its own IdP / iframe handoff in worker/auth.ts).
 *
 * SECURITY: ZOOCLAW_API_KEY authenticates this Worker as your whole organization. It must
 * never be sent to the browser, logged, or embedded in a client bundle.
 */
import { createZooclawClient, type ZooclawClient } from '@zooclaw-agents/sdk'

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
