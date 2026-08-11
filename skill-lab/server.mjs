// A lab for the two things you can actually change about an agent: its persona, and the
// skills it carries. Everything here runs against ONE agent this template owns.

import { createServer } from 'node:http'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createZooclawClient,
  ZooclawError,
  assistantText,
  isRunFinished,
  runOutcome,
  toolCall,
} from '@zooclaw-agents/sdk'

import { makeZip } from './zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(HERE, 'skills')
const AGENT_FILE = join(HERE, '.agent') // remembers the lab agent across restarts

await loadDotEnv(join(HERE, '.env'))

const API_KEY = process.env.ZOOCLAW_API_KEY
const PORT = Number(process.env.PORT || 3000)

if (!API_KEY) {
  console.error(`\nMissing ZOOCLAW_API_KEY.\n\n  cp .env.example .env\n\nthen paste your org key (zct_…).\n`)
  process.exit(1)
}

const zc = createZooclawClient({ apiKey: API_KEY, baseUrl: process.env.ZOOCLAW_BASE_URL })

// ─── the lab agent ───────────────────────────────────────────────────────────

// Unlike `chat/`, this template BUILDS an agent — that is the whole point. It makes one
// the first time it runs and remembers it in `.agent`, so restarting does not litter your
// org with agents. Set ZOOCLAW_AGENT_ID to point the lab at one you already own instead.
async function resolveAgent() {
  const pinned = process.env.ZOOCLAW_AGENT_ID || (await readFile(AGENT_FILE, 'utf8').catch(() => '')).trim()
  if (pinned) {
    const agent = await zc.getAgent(pinned).catch(() => null)
    if (agent) return ensureRunning(pinned)
    console.log(`remembered agent ${pinned} is gone, building a new one`)
  }

  const models = await zc.listModels()
  const model = models.find((m) => /claude/i.test(m.model))?.model ?? models[0]?.model
  console.log(`building a lab agent on ${model}…`)

  // `ownership` is required by the schema but the gateway overwrites it with your key's
  // tenant, so placeholders are correct here — do not go looking for your real uid.
  const created = await zc.createAgent({
    resource: {
      name: 'skill-lab',
      model: { primary: model },
      persona: { docs: [{ name: 'AGENTS.md', content: DEFAULT_PERSONA }] },
    },
    ownership: { owner_uid: 'placeholder', org_id: 'placeholder' },
  })
  await writeFile(AGENT_FILE, created.agent_id)
  console.log(`built ${created.agent_id}`)
  return ensureRunning(created.agent_id)
}

const DEFAULT_PERSONA = 'You are a helpful assistant. Answer briefly.'

// Poll `desired_state` — `actual_state` tracks chat-channel connectivity and parks at
// `activating` forever for an API-only agent.
async function ensureRunning(agentId) {
  const agent = await zc.getAgent(agentId)
  if (agent.status?.desired_state !== 'running') {
    await zc.startAgent(agentId)
    for (let i = 0; i < 40; i += 1) {
      const a = await zc.getAgent(agentId)
      if (a.status?.desired_state === 'running') break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return agentId
}

const AGENT_ID = await resolveAgent()

// ─── state the page renders ──────────────────────────────────────────────────

async function localSkills() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const md = await readFile(join(SKILLS_DIR, e.name, 'SKILL.md'), 'utf8').catch(() => null)
    if (!md) continue
    out.push({ dir: e.name, ...frontmatter(md) })
  }
  return out
}

// The frontmatter `description` is the ONLY thing the agent sees when deciding whether a
// skill is relevant. The body is loaded afterwards, and only if the description won. The
// page shows it for exactly that reason.
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  const block = m?.[1] ?? ''
  const field = (k) => block.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
  return { name: field('name'), description: field('description') }
}

async function state() {
  const agent = await zc.getAgent(AGENT_ID)
  const attached = await zc.listAgentSkills(AGENT_ID).catch(() => [])
  const list = Array.isArray(attached) ? attached : (attached?.skills ?? [])
  return {
    agent: {
      id: AGENT_ID,
      name: agent.declared?.name ?? 'skill-lab',
      model: agent.declared?.model?.primary ?? '',
      persona: agent.declared?.persona?.docs?.[0]?.content ?? '',
      configVersion: agent.status?.config_version ?? agent.config_version,
    },
    // Skills the platform attached at birth. You cannot pick these and you cannot remove
    // them — `putAgentSkill` on a `global` skill is a 404. They simply come with the agent.
    builtin: list.filter((s) => s.scope === 'global').map((s) => s.name).sort(),
    // Skills YOU uploaded. These are the ones this lab can add and remove.
    installed: list.filter((s) => s.scope !== 'global').map((s) => ({ id: s.skill_id, name: s.name, scope: s.scope })),
    available: await localSkills(),
  }
}

// ─── installing a skill ──────────────────────────────────────────────────────

async function install(dir) {
  const md = await readFile(join(SKILLS_DIR, dir, 'SKILL.md'))
  const { name } = frontmatter(md.toString('utf8'))
  if (!name) throw new Error(`skills/${dir}/SKILL.md has no \`name:\` in its frontmatter`)

  // The zip's top-level directory must match the frontmatter `name`, or the upload is
  // rejected with a message saying exactly that.
  const zip = makeZip([{ name: `${name}/SKILL.md`, data: md }])

  // Re-uploading the same name is a new VERSION, not a new skill. Agents that installed it
  // unpinned follow the new version by themselves — no second putAgentSkill needed.
  const existing = (await zc.listSkills({ scope: 'org' }).catch(() => [])).find((s) => s.name === name)
  const record = existing
    ? await zc.uploadSkillVersion(existing.skill_id, zip, { fileName: `${name}.zip` })
    : await zc.uploadSkill(zip, { scope: 'org', fileName: `${name}.zip` })

  const skillId = record.skill_id ?? existing?.skill_id
  const { warnings } = await zc.putAgentSkill(AGENT_ID, skillId)
  return { skillId, name, updated: Boolean(existing), warnings: warnings ?? [] }
}

async function uninstall(skillId) {
  await zc.deleteAgentSkill(AGENT_ID, skillId)
  // Also drop it from the org registry so re-installing starts from version 1 again.
  await zc.deleteSkill(skillId).catch(() => {})
}

// ─── asking ──────────────────────────────────────────────────────────────────

// EVERY question opens a FRESH session. That is deliberate and it is what makes the
// before/after comparison honest: in one session the agent would simply remember its
// previous answer, and you would be reading its memory rather than its skills.
async function ask(question, send) {
  const session = await zc.createSession(AGENT_ID, {
    metadata: { source: 'skill-lab' },
    initial_events: [{ type: 'user.message', content: question }],
  })

  const ctl = new AbortController()
  const budget = setTimeout(() => ctl.abort(), 3 * 60_000)
  let outcome
  try {
    for await (const event of zc.streamEvents(AGENT_ID, session.session_id, { signal: ctl.signal })) {
      if (event.eventType === 'agent.thinking') send({ type: 'status', label: 'thinking' })
      const call = toolCall(event)
      if (call?.phase === 'start') send({ type: 'status', label: `using ${call.toolName}` })
      const text = assistantText(event)
      if (text) send({ type: 'text', text })
      if (isRunFinished(event)) {
        outcome = runOutcome(event)
        break
      }
    }
  } finally {
    clearTimeout(budget)
    ctl.abort()
  }
  send({ type: 'done', outcome: outcome ?? 'unknown' })
}

// ─── routes ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(await readFile(join(HERE, 'web', 'index.html')))
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state())

    if (req.method === 'POST' && url.pathname === '/api/persona') {
      const { content } = await readJson(req)
      // updateAgent merges by SECTION: sending `persona` replaces the whole persona
      // section and leaves model/labels/tool_policy alone. Every write bumps
      // config_version, so only send when something actually changed.
      await zc.updateAgent(AGENT_ID, { persona: { docs: [{ name: 'AGENTS.md', content: content ?? '' }] } })
      return json(res, 200, await state())
    }

    if (req.method === 'POST' && url.pathname === '/api/install') {
      const { dir } = await readJson(req)
      const result = await install(dir)
      return json(res, 200, { ...result, state: await state() })
    }

    if (req.method === 'POST' && url.pathname === '/api/uninstall') {
      const { skillId } = await readJson(req)
      await uninstall(skillId)
      return json(res, 200, await state())
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const { question } = await readJson(req)
      if (!question?.trim()) return json(res, 400, { error: 'empty question' })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`)
      try {
        await ask(question, send)
      } catch (e) {
        console.error(e)
        send({ type: 'error', message: describe(e) })
      }
      return res.end()
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: 'internal server error' })
    else res.end()
  }
})

// ─── plumbing ────────────────────────────────────────────────────────────────

function describe(e) {
  if (e instanceof ZooclawError) {
    if (e.status === 401) return 'ZooClaw rejected the API key (401). Check ZOOCLAW_API_KEY in .env.'
    if (e.status === 404) return 'Not found (404). Installing a BUILT-IN skill returns this — those cannot be added or removed.'
    return `ZooClaw error ${e.status}${e.type ? ` ${e.type}` : ''}: ${e.message}`
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

async function loadDotEnv(path) {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (!raw) return
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i)
    if (!m) continue
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

server.listen(PORT, async () => {
  const s = await state().catch(() => null)
  console.log(`\n  lab agent ${AGENT_ID}`)
  if (s) console.log(`  ${s.builtin.length} built-in skills, ${s.installed.length} of yours`)
  console.log(`  http://localhost:${PORT}\n`)
})
