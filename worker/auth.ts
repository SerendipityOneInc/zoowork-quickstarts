/**
 * Cloudflare Access identity — the kit's default login gateway. Access (your IdP + email
 * allowlist) sits in front of the Worker and injects a signed JWT in
 * `Cf-Access-Jwt-Assertion`. We verify it against the team's JWKS and return the
 * authenticated email — the tenant key for the whole app.
 *
 * Verifying the JWT (not just trusting the `Cf-Access-Authenticated-User-Email` header)
 * means a request that bypasses Access can't spoof an identity. Local dev sets DEV_EMAIL
 * in .dev.vars to skip Access entirely. To use a different IdP (Clerk, an iframe handoff,
 * …) this is the one file a vertical swaps.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Env } from './env.ts'

// JWKS is cached per team domain for the isolate's lifetime (jose caches the keys too).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
let jwksTeam = ''

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksTeam !== teamDomain) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
    jwksTeam = teamDomain
  }
  return jwks
}

/** The verified user email, or null if unauthenticated. DEV_EMAIL short-circuits for local dev. */
export async function authedEmail(req: Request, env: Env): Promise<string | null> {
  if (env.DEV_EMAIL) return env.DEV_EMAIL
  const token = req.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null
  try {
    const { payload } = await jwtVerify(token, getJwks(env.CF_ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: env.CF_ACCESS_AUD,
    })
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}
