// The whole backend. Three routes, no framework, no database.
//
// It exists for one reason: ZOOCLAW_API_KEY authenticates your entire organization, so it
// must never reach a browser. Everything here is the smallest correct way to keep it here
// while still letting a page talk to your agent.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createZooclawClient,
  ZooclawError,
  assistantText,
  isRunFinished,
  messageText,
  runOutcome,
  toolCall,
} from '@zooclaw-agents/sdk'

const HERE = dirname(fileURLToPath(import.meta.url))

// ─── config ──────────────────────────────────────────────────────────────────

await loadDotEnv(join(HERE, '.env'))

const API_KEY = process.env.ZOOCLAW_API_KEY
const AGENT_ID = process.env.ZOOCLAW_AGENT_ID
const PORT = Number(process.env.PORT || 3000)

if (!API_KEY || !AGENT_ID) {
  console.error(
    `\nMissing configuration.\n\n` +
      `  cp .env.example .env\n\n` +
      `then fill in:\n` +
      `  ZOOCLAW_API_KEY   ${API_KEY ? 'ok' : 'MISSING — your org key, starts with zct_'}\n` +
      `  ZOOCLAW_AGENT_ID  ${AGENT_ID ? 'ok' : 'MISSING — your agent id, starts with agt_'}\n\n` +
      `Both are copied from the ZooClaw workspace UI.\n`
  )
  process.exit(1)
}

// baseUrl is optional — the SDK already points at the public gateway.
const zc = createZooclawClient({ apiKey: API_KEY, baseUrl: process.env.ZOOCLAW_BASE_URL })

// ─── preflight ───────────────────────────────────────────────────────────────

// Sessions require the agent to be running. An agent you built in the workspace UI is
// usually already running, so this is normally a single GET — but an agent that was
// stopped needs starting, and without it every createSession returns 409.
//
// Poll `desired_state`, never `actual_state`: actual_state tracks CHAT CHANNEL
// connectivity, an API-only agent parks at `activating` forever, and `running` is not
// even in its enum. A loop waiting on actual_state never returns.
async function ensureRunning(agentId) {
  const agent = await zc.getAgent(agentId)
  const name = agent.declared?.name ?? agentId
  if (agent.status?.desired_state === 'running') return name

  console.log(`agent is ${agent.status?.desired_state}, starting it…`)
  await zc.startAgent(agentId) // may warn `channel_routes_reload_failed` — expected, harmless
  for (let i = 0; i < 30; i += 1) {
    const a = await zc.getAgent(agentId)
    if (a.status?.desired_state === 'running') return name
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`agent ${agentId} never reached desired_state=running`)
}

// ─── conversation state ──────────────────────────────────────────────────────

// The only thing this server remembers: each session's stream resume token, so a new
// turn streams only new events. Everything else lives in ZooClaw — the browser holds a
// session id, and the transcript is fetched back from the platform on reload.
const cursors = new Map()

async function resumeFor(sessionId) {
  const cursor = cursors.get(sessionId)
  if (cursor) return { cursor }
  // Server restarted: no token in hand, and tokens are opaque — never mint one from a
  // seq. Stream from the log start instead and drop everything at or below the known
  // end; the first live event hands us a fresh token to remember.
  const events = await zc.listAllEvents(AGENT_ID, sessionId)
  return { skipThrough: events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0) }
}

// ─── routes ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(HERE, 'web', 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    // Rebuild a conversation after a page reload.
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const sessionId = url.searchParams.get('session')
      if (!sessionId) return json(res, 400, { error: 'missing ?session' })
      return json(res, 200, { messages: await history(sessionId) })
    }

    // Send a message and stream the reply.
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      return await chat(req, res)
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: describe(e) })
    else res.end()
  }
})

// ─── reading a conversation back ─────────────────────────────────────────────

// ONE surface. The event log is bidirectional: what you post echoes back as
// `user.message` events alongside the agent's `agent.assistant` replies, so the whole
// two-sided transcript rebuilds from a single filtered read — for a session of any
// length, from any device. (`getSession(..., { history: true })` still exists; you only
// need it for per-turn token usage and the model that actually answered.)
async function history(sessionId) {
  const events = await zc.listAllEvents(AGENT_ID, sessionId, {
    types: ['user.message', 'agent.assistant'],
  })
  const out = []
  for (const ev of events) {
    const user = ev.eventType === 'user.message'
    // `messageText` reads the text blocks out of either payload shape and skips the
    // model's `thinking` scratchpad blocks on its own.
    const text = messageText(user ? ev.payload : ev.payload.message).trim()
    if (text) out.push({ role: user ? 'user' : 'assistant', text })
  }
  return out
}

// ─── sending a message ───────────────────────────────────────────────────────

async function chat(req, res) {
  const { message, session } = await readJson(req)
  if (!message?.trim()) return json(res, 400, { error: 'empty message' })

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`)

  let sessionId = session
  let resume = {}

  try {
    if (!sessionId) {
      // First message: creating the session and sending the message are one call.
      // `metadata` is stored verbatim and comes back on read — a handy place for a title.
      const created = await zc.createSession(AGENT_ID, {
        metadata: { source: 'quickstart-chat', title: message.slice(0, 60) },
        initial_events: [{ type: 'user.message', content: message }],
      })
      sessionId = created.session_id
      send({ type: 'session', session: sessionId })
    } else {
      resume = await resumeFor(sessionId)
      // Follow-up turns post into the SAME session. The platform holds the context, so
      // there is no history to re-send. The accepted event comes back as the full event
      // object your message will show up as in the log (its `seq` included).
      await zc.postEvents(AGENT_ID, sessionId, [{ type: 'user.message', content: message }])
    }

    await streamTurn(sessionId, resume, send)
  } catch (e) {
    console.error(e)
    send({ type: 'error', message: describe(e) })
  }
  res.end()
}

async function streamTurn(sessionId, resume, send) {
  const ctl = new AbortController()
  const budget = setTimeout(() => ctl.abort(), 5 * 60_000)
  let outcome

  try {
    const opts = resume.cursor ? { cursor: resume.cursor, signal: ctl.signal } : { signal: ctl.signal }
    for await (const event of zc.streamEvents(AGENT_ID, sessionId, opts)) {
      if (event.cursor) cursors.set(sessionId, event.cursor)
      // Restart recovery: drop what the browser already rendered from /api/history.
      if (resume.skipThrough && event.seq > 0 && event.seq <= resume.skipThrough) continue

      // Honest progress, not a fake typing animation. Replies arrive as ONE whole
      // message — there is no token-by-token delta — so these events are what you have
      // to show while the user waits.
      if (event.eventType === 'agent.thinking') send({ type: 'status', label: 'thinking' })
      const call = toolCall(event)
      if (call?.phase === 'start') send({ type: 'status', label: `using ${call.toolName}` })

      const text = assistantText(event)
      if (text) send({ type: 'text', text })

      // The stream is scoped to the SESSION and stays open after a turn ends. Break here
      // or you block until the server's idle timeout.
      if (isRunFinished(event)) {
        outcome = runOutcome(event)
        break
      }
    }
  } finally {
    clearTimeout(budget)
    ctl.abort()
  }

  // A run can finish `succeeded` with failed tool calls inside it — outcome and tool
  // errors are independent signals.
  send({ type: 'done', outcome: outcome ?? 'unknown' })
}

// ─── plumbing ────────────────────────────────────────────────────────────────

function describe(e) {
  if (e instanceof ZooclawError) {
    if (e.status === 401) return 'ZooClaw rejected the API key (401). Check ZOOCLAW_API_KEY in .env.'
    if (e.status === 404) return 'Not found (404). Most often the agent id belongs to a different organization than the key.'
    if (e.type === 'agent_not_running') return 'The agent is not running (409). Restart this server — it starts the agent on boot.'
    return `ZooClaw error ${e.status}${e.type ? ` ${e.type}` : ''}: ${e.message}`
  }
  // A transport failure arrives as the two words 'fetch failed'; the real reason is on .cause.
  if (e?.name === 'TypeError' && /fetch failed/i.test(e.message ?? '')) {
    const why = e.cause?.message ?? e.cause?.code ?? 'no route to the gateway'
    return `Could not reach the ZooClaw gateway (${why}). Check your network, VPN or proxy, and ZOOCLAW_BASE_URL if you set one.`
  }
  return e?.message ?? String(e)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

// A dependency-free `.env` reader: KEY=value per line, `#` comments, optional quotes.
async function loadDotEnv(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return // no .env — the config check below produces the real message
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i)
    if (!m) continue
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────

try {
  const name = await ensureRunning(AGENT_ID)
  server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.\n\n  PORT=3001 npm run dev\n`)
    process.exit(1)
  }
  throw e
})

server.listen(PORT, () => {
    console.log(`\n  talking to "${name}"\n  http://localhost:${PORT}\n`)
  })
} catch (e) {
  console.error(`\nCould not reach your agent.\n\n  ${describe(e)}\n`)
  process.exit(1)
}
