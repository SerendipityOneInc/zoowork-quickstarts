/**
 * Cloudflare Worker entry — the composition root for the Workers-native build.
 *
 *   /api/app/*  → the shared Hono API (server/routes.ts), with the D1 store and a
 *                 Durable-Object-backed turn runner injected per request.
 *   everything  → the static SPA (vite build/) via the ASSETS binding (SPA fallback in
 *                 wrangler.jsonc → not_found_handling).
 *
 * The DO class is re-exported here because wrangler binds Durable Objects to the classes
 * exported from the Worker's main module. Identity is Cloudflare Access by default
 * (worker/auth.ts) — the one file a vertical swaps to use a different IdP.
 *
 * TRUST BOUNDARY: this Worker is the "mini claw-interface" — it verifies the end user
 * (Access JWT), then talks to the ZooClaw API with the ONE service bearer. The token lives only
 * here and in the DO; nothing in src/ (the browser bundle) ever sees it.
 */
import { Hono } from 'hono'
import { createD1Store } from '../server/store-d1.ts'
import { app as api, type RouteVars } from '../server/routes.ts'
import { authedEmail } from './auth.ts'
import { zooclawClient, type Env } from './env.ts'

export { TaskDO } from './task-do.ts'

const app = new Hono<{ Bindings: Env; Variables: RouteVars }>()

app.use('/api/app/*', async (c, next) => {
  const env = c.env
  // Optional embed gate, checked before any tenant work (stops strangers spinning resources).
  if (env.EMBED_KEY) {
    const key = c.req.header('X-Embed-Key') || c.req.query('k') || ''
    if (key !== env.EMBED_KEY) return c.json({ error: 'forbidden' }, 401)
  }
  const email = await authedEmail(c.req.raw, env)
  if (!email) return c.json({ error: 'unauthorized' }, 401)

  const store = createD1Store(env.DB)
  c.set('userEmail', email)
  c.set('store', store)
  c.set('runTurn', async (taskId, _projectId, promptId, prompt, opts) => {
    return env.TASK_DO.getByName(taskId).runTurn(taskId, promptId, prompt, email, opts?.agentConfig)
  })
  c.set('cancelTurn', async (promptId) => {
    const p = await store.getPrompt(promptId)
    if (!p) return false
    return env.TASK_DO.getByName(p.task_id).cancel(promptId)
  })
  c.set('recoverPrompt', async (taskId, promptId) => {
    return env.TASK_DO.getByName(taskId).recoverPrompt(promptId)
  })
  c.set('answerQuestion', async (taskId, body) => {
    // Deliver the user's approval/answer to the session as a user.tool_confirmation
    // event, then nudge the DO so its next streaming window picks up the resumed turn's
    // frames immediately. Payload shape is the kit's own triple passed through —
    // [verify] against the API once the confirmation schema is published
    // (the API reference).
    const task = await store.getTask(taskId)
    const sessionId = task?.session_id
    if (!sessionId) throw new Error('Zooclaw session missing for this conversation')
    // Fixed-agent mode provisions nothing, so there is no zooclaw_agents row to read.
    const agentId = env.ZOOCLAW_AGENT_ID || (await store.getZooclawAgent(email))?.agentId
    if (!agentId) throw new Error('Zooclaw agent missing for this user')
    await zooclawClient(env).postEvents(agentId, sessionId, [
      { type: 'user.tool_confirmation', message_id: body.messageId, action_id: body.actionId, answer: body.answer },
    ])
    await env.TASK_DO.getByName(taskId).nudge()
  })
  // Attachments ship disabled (domain/agent.ts ATTACHMENTS_ENABLED): Zooclaw's Files API
  // has no production file staging yet. The route 501s before this is ever called; the
  // stub keeps the seam so a vertical can wire real staging without touching routes.
  c.set('uploadFile', async () => {
    throw new Error('attachments are disabled: Zooclaw Files is not production-wired yet')
  })
  await next()
})

app.route('/api/app', api)

// Everything else is the SPA (served by the assets binding; SPA fallback in wrangler.jsonc).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
