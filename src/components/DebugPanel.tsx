import { useState } from 'react'
import { useAtomValue } from 'jotai'
import type { PromptContent, RuntimeConfig } from '../api.ts'
import { useConfig } from '../hooks/useConfig.ts'
import { configAtom } from '../store/agent-config.ts'
import { buildToolPolicy, TOOLS } from '../../domain/agent.ts'

/**
 * The default right-hand pane, in two tabs.
 *
 *   Config — what you can actually control: this deployment's mode + wired variables (from
 *            GET /api/app/config, presence only — no secret value is ever sent to the
 *            browser), the agent config the settings pane edits, and this conversation's
 *            live ids. Plus an honest list of what the kit does NOT let you change.
 *   Frames — the raw inspector: every turn's prompt and the stream-json frames the backend
 *            stored, including the `__zooclaw` typed-event passthroughs chat hides.
 *
 * Config leads because a newcomer's first question is "what am I allowed to change, and
 * where does it land?" — the frame dump answers neither. There is no public console for a
 * Zooclaw session, so raw ids (monospace, click-to-copy) ARE the debugging affordance.
 * Replace the whole pane via domain/view.tsx.
 */
export function DebugPanel({ prompts }: { prompts: PromptContent[] }) {
  const [tab, setTab] = useState<'config' | 'frames'>('config')
  const frameCount = prompts.reduce((n, p) => n + p.frames.length, 0)
  return (
    <div className="bench">
      <div className="bench-tabs" role="tablist" aria-label="Debug panel">
        <button role="tab" aria-selected={tab === 'config'} className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
          Config
        </button>
        <button role="tab" aria-selected={tab === 'frames'} className={tab === 'frames' ? 'active' : ''} onClick={() => setTab('frames')}>
          Frames <span className="bench-tab-count">{frameCount}</span>
        </button>
      </div>
      {tab === 'config' ? <ConfigTab prompts={prompts} /> : <FramesTab prompts={prompts} />}
    </div>
  )
}

// ── Config tab ─────────────────────────────────────────────────────────────

function ConfigTab({ prompts }: { prompts: PromptContent[] }) {
  const runtime = useConfig()
  const config = useAtomValue(configAtom)
  const id = conversationIdentity(prompts)
  const policy = JSON.stringify(buildToolPolicy(config.tools))
  const toolsOn = TOOLS.filter((t) => config.tools[t.key] ?? t.defaultOn)

  return (
    <div className="cfg">
      <section className="cfg-section">
        <h3 className="cfg-title">Runtime</h3>
        <p className="cfg-caption muted">
          How this deployment is wired. Read-only — it comes from the Worker's environment, so changing it means a redeploy.
        </p>
        {runtime.isPending && <div className="muted">Loading…</div>}
        {runtime.isError && <div className="cfg-empty">GET /api/app/config failed — the Worker may not be running.</div>}
        {runtime.data && <RuntimeRows config={runtime.data} />}
      </section>

      <section className="cfg-section">
        <h3 className="cfg-title">Agent config you can edit right now</h3>
        <p className="cfg-caption muted">Edited in the settings pane above; applied to your Zooclaw agent on the first turn of a session.</p>

        <Knob
          name="System prompt"
          value={config.systemPrompt.trim() || '(empty)'}
          where="Settings · System prompt"
          lands="PUT /agents/{id} · persona.docs[AGENTS.md]"
          onEdit={() => jumpTo('sys-prompt')}
        />
        <Knob
          name="Tools"
          value={toolsOn.length ? toolsOn.map((t) => t.toolName).join(', ') : 'none allowed'}
          where="Settings · Tools"
          lands={`PUT /agents/{id} · tool_policy ${policy}`}
          onEdit={() => jumpTo('agent-tools')}
        />
        <Knob
          name="Skill"
          value={config.skillId?.trim() || 'none installed'}
          where="Settings · Skill ID"
          lands="PUT /agents/{id}/skills/{skill_id} · unpinned, follows the latest ready version"
          onEdit={() => jumpTo('skill-id')}
        />

        <p className="cfg-note">
          Applies to the <b>next new chat</b>. The current conversation keeps the config its session was created with, and a
          config PUT bumps <code>config_version</code> on every call, so the kit writes only what actually drifted.
        </p>
      </section>

      <section className="cfg-section">
        <h3 className="cfg-title">This conversation</h3>
        <p className="cfg-caption muted">Live ids for the open chat. Click to copy — there is no public console to link to.</p>
        <IdRow
          label="Agent"
          value={id.agentId}
          // A session with no agent id means the marker frame predates carrying one; no
          // session at all means the conversation simply has not started.
          empty={id.sessionId ? "not recorded in this conversation's frames" : 'not created yet — send a message'}
        />
        <IdRow label="Session" value={id.sessionId} empty="not created yet — send a message" />
        <div className="cfg-counts">
          <span>
            <b>{id.turns}</b> {id.turns === 1 ? 'turn' : 'turns'}
          </span>
          <span>
            <b>{id.frames}</b> {id.frames === 1 ? 'frame' : 'frames'}
          </span>
        </div>
      </section>

      <section className="cfg-section">
        <h3 className="cfg-title">Not configurable from the kit</h3>
        <ul className="cfg-limits">
          <li>
            <b>Environment pin</b> — locked once the first sandbox exists; later changes return 409 <code>environment_locked</code>, and
            stopping the agent does not clear it.
          </li>
          <li>
            <b>Platform credentials</b> — the gateway owns them and answers <code>credentials/*</code> with 404.
          </li>
          <li>
            <b>File attachments</b> — off (<code>ATTACHMENTS_ENABLED=false</code>): the Files API is not wired and returns 502.
          </li>
          <li>
            <b>MCP servers</b> — declarable through <code>updateAgent</code>, but an authenticated server needs a credential slug the
            gateway cannot store.
          </li>
          <li>
            <b>Session PATCH</b> — the gateway does not proxy PATCH, so a session cannot be edited in place (405).
          </li>
        </ul>
      </section>
    </div>
  )
}

function RuntimeRows({ config }: { config: RuntimeConfig }) {
  const r = config.runtime
  return (
    <>
      <Knob
        name="Transport"
        value={r.transport === 'gateway' ? 'gateway (org service token)' : 'unconfigured'}
        where="ZOOCLAW_API_KEY"
        lands="Bearer on every ZooClaw API call; the gateway enforces tenancy"
      />
      <Knob
        name="Provisioning"
        value={r.provisioning === 'fixed-agent' ? 'fixed agent (shared by everyone)' : 'per user (created on first use)'}
        where="ZOOCLAW_AGENT_ID"
        lands={
          r.provisioning === 'fixed-agent'
            ? 'nothing is provisioned — no create, no credentials, no config PUT'
            : 'POST /agents → start → config PUT, cached per email'
        }
      />
      <Knob
        name="API base URL"
        value={r.apiBaseUrl}
        mono
        where={r.apiBaseUrlFrom === 'ZOOCLAW_API_URL' ? 'ZOOCLAW_API_URL' : 'SDK default'}
        lands="the origin every agent / session / event call is sent to"
      />
      <Knob
        name="Sign-in"
        value={r.identity === 'cloudflare-access' ? 'Cloudflare Access' : r.identity === 'dev-email' ? 'DEV_EMAIL (local dev)' : 'unconfigured'}
        where={r.identity === 'dev-email' ? 'DEV_EMAIL' : 'CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD'}
        lands="the verified email — the tenant key every conversation is stored under"
      />
      <Knob
        name="Embed gate"
        value={r.embedGate ? 'on — every call must present the key' : 'off'}
        where="EMBED_KEY"
        lands="X-Embed-Key header or ?k= on /api/app/*"
      />
      <Knob
        name="Attachments"
        value={r.attachments ? 'on' : 'off'}
        where="domain/agent.ts ATTACHMENTS_ENABLED"
        lands="POST /api/app/files (501 while off)"
      />

      <div className="cfg-envhead">
        Deployment variables
        <span className="muted"> — the panel receives only whether each one is set; values never leave the Worker.</span>
      </div>
      <div className="cfg-envlist">
        {config.env.map((v) => (
          <div key={v.name} className="cfg-env">
            <div className="cfg-env-head">
              <span className="mono cfg-env-name">{v.name}</span>
              {v.secret && <span className="cfg-badge">secret</span>}
              <span className={`cfg-pill ${v.configured ? 'on' : 'off'}`}>{v.configured ? 'set' : 'not set'}</span>
            </div>
            <div className="cfg-env-effect muted">{v.effect}</div>
          </div>
        ))}
      </div>
    </>
  )
}

/** One knob: what it is, its current effective value, where it is set, where it lands. */
function Knob({
  name,
  value,
  where,
  lands,
  mono,
  onEdit,
}: {
  name: string
  value: string
  where: string
  lands: string
  mono?: boolean
  /** Present → render a jump button instead of duplicating the editor here. */
  onEdit?: () => void
}) {
  return (
    <div className="cfg-row">
      <div className="cfg-row-head">
        <span className="cfg-name">{name}</span>
        <span className={`cfg-value${mono ? ' mono' : ''}`}>{value}</span>
        {onEdit && (
          <button className="ghost cfg-edit" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      <div className="cfg-meta muted">
        <span>set in {where}</span>
        <span className="cfg-lands mono">{lands}</span>
      </div>
    </div>
  )
}

/** A copyable id (monospace). Falls back to a plain, still-selectable value when the
 *  clipboard is unavailable (a non-secure origin blocks navigator.clipboard). */
function IdRow({ label, value, empty }: { label: string; value: string | null; empty: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="cfg-id">
      <span className="cfg-name">{label}</span>
      {value ? (
        <button
          className="cfg-copy mono"
          title="Copy"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              },
              () => {
                /* clipboard blocked — the id stays on screen and selectable */
              },
            )
          }}
        >
          {value}
          <span className="cfg-copy-hint">{copied ? 'copied' : 'copy'}</span>
        </button>
      ) : (
        <span className="cfg-value cfg-empty">{empty}</span>
      )}
    </div>
  )
}

/** Scroll the settings pane's field into view and focus it — the Config tab names the
 *  knobs, the settings pane stays the single place they are edited. */
function jumpTo(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  // scrollIntoView ignores the OS motion preference on its own; the rest of the kit honours
  // it (see the reduced-motion block in styles.css), so opt out of the animation explicitly.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.focus({ preventScroll: true })
}

/**
 * This conversation's Zooclaw identity, read from the `__zooclaw_session` marker frame the
 * turn runner emits once per session (worker/task-do.ts) — the same source the Frames tab
 * shows inline. Conversations started before the marker carried `agent_id` report a session
 * with no agent.
 */
export function conversationIdentity(prompts: PromptContent[]): {
  agentId: string | null
  sessionId: string | null
  turns: number
  frames: number
} {
  let agentId: string | null = null
  let sessionId: string | null = null
  let frames = 0
  for (const p of prompts) {
    frames += p.frames.length
    for (const f of p.frames) {
      if (!f.data || typeof f.data !== 'object') continue
      const d = f.data as Record<string, unknown>
      if (typeof d.__zooclaw_session !== 'string') continue
      sessionId = d.__zooclaw_session
      if (typeof d.agent_id === 'string') agentId = d.agent_id
    }
  }
  return { agentId, sessionId, turns: prompts.length, frames }
}

// ── Frames tab (the original raw inspector, unchanged) ─────────────────────

function FramesTab({ prompts }: { prompts: PromptContent[] }) {
  if (!prompts.length) {
    return (
      <div className="bench-empty">
        <div className="bench-empty-mark">{'{ }'}</div>
        <p className="muted">Nothing yet. Send a message and every raw frame shows up here.</p>
      </div>
    )
  }
  return (
    <div className="debug">
      {prompts.map((p, i) => (
        <div key={p.id} className="debug-turn">
          <div className="debug-turn-head">
            turn {i + 1} · <span className="mono">{p.id.slice(0, 8)}</span> ·{' '}
            <span className={`debug-status s-${p.status ?? 'running'}`}>{p.status ?? 'running'}</span> ·{' '}
            <span className="muted">{p.frames.length} frames</span>
          </div>
          <div className="debug-prompt"><span className="muted">prompt</span> {p.prompt}</div>
          <div className="debug-frames">
            {p.frames.length === 0
              ? <div className="muted">(no frames)</div>
              : p.frames.map((f) => <FrameRow key={f.seq} seq={f.seq} data={f.data} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function FrameRow({ seq, data }: { seq: number; data: unknown }) {
  const [open, setOpen] = useState(false)
  // The session marker gets its id shown inline (selectable/copyable) — there is no
  // public Zooclaw console to link to, so the raw id IS the debugging affordance.
  const sessionId =
    data && typeof data === 'object' && typeof (data as Record<string, unknown>).__zooclaw_session === 'string'
      ? ((data as Record<string, unknown>).__zooclaw_session as string)
      : null
  return (
    <div className="debug-frame">
      <button className="debug-frame-head" onClick={() => setOpen((o) => !o)}>
        <span className="debug-seq">#{seq}</span>
        <span className="debug-kind">{frameLabel(data)}</span>
        {sessionId && <span className="mono">{sessionId}</span>}
        <span className="debug-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && <pre className="debug-json">{JSON.stringify(data, null, 2)}</pre>}
    </div>
  )
}

/** Exported for the frame-vocabulary test in src/chat.test.ts (chat hides what this labels). */
export function frameLabel(data: unknown): string {
  if (!data || typeof data !== 'object') return typeof data
  const d = data as Record<string, unknown>
  if (typeof d.__zooclaw_session === 'string') return 'zooclaw_session'
  if (typeof d.__error === 'string') return 'error'
  if (d.__ask && typeof d.__ask === 'object') return 'ask_user_question'
  if (typeof d.__zooclaw === 'string') return String(d.__zooclaw)
  if (d.type === 'assistant') {
    const content = (d.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_use')) return 'assistant · tool_use'
    return 'assistant · text'
  }
  if (d.type === 'user') return 'user · tool_result'
  return String(d.type ?? 'frame')
}
