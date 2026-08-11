import { useState } from 'react'
import { useAtom } from 'jotai'
import type { PromptContent, RuntimeConfig } from '../api.ts'
import { useConfig } from '../hooks/useConfig.ts'
import { useEffectiveAgent } from '../hooks/useAgent.ts'
import { configAtom } from '../store/agent-config.ts'
import { buildToolPolicy, TOOLS } from '../../domain/agent.ts'
import { AgentPanel } from './AgentPanel.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { IdRow, Knob, Section, jumpTo } from './panel-bits.tsx'

/**
 * The right-hand pane, in four tabs — one per capability surface of the SDK, so "what can I
 * actually do here?" has a tab rather than a scroll position:
 *
 *   Agent   — which agent this deployment talks to, and (when allowed) a picker to change it.
 *   Config  — the agent config the kit applies: persona, tool toggles, skill pin. Read-only
 *             for a borrowed agent, because that agent belongs to somebody else.
 *   Runtime — how this deployment is wired (transport, identity, variables). Redeploy to change.
 *   Debug   — the raw frame stream, including the `__zooclaw` passthroughs chat hides.
 *
 * Agent leads: everything else in the pane is qualified by WHICH agent you are on, and until
 * this tab existed that answer was buried in a marker frame. Each section names the SDK
 * methods behind it (see panel-bits Section) — the kit is a teaching probe for the SDK, so a
 * reader should get from a control to a call without leaving the pane.
 *
 * Replace the whole pane via domain/view.tsx.
 */
type Tab = 'agent' | 'config' | 'runtime' | 'debug'

export function DebugPanel({ prompts }: { prompts: PromptContent[] }) {
  const [tab, setTab] = useState<Tab>('agent')
  const frameCount = prompts.reduce((n, p) => n + p.frames.length, 0)
  const tabButton = (id: Tab, label: string, extra?: React.ReactNode) => (
    <button role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
      {label}
      {extra}
    </button>
  )
  return (
    <div className="bench">
      <div className="bench-tabs" role="tablist" aria-label="Agent panel">
        {tabButton('agent', 'Agent')}
        {tabButton('config', 'Config')}
        {tabButton('runtime', 'Runtime')}
        {tabButton('debug', 'Debug', <span className="bench-tab-count">{frameCount}</span>)}
      </div>
      {tab === 'agent' && <AgentTab prompts={prompts} />}
      {tab === 'config' && <ConfigTab hasConversation={prompts.length > 0} />}
      {tab === 'runtime' && <RuntimeTab />}
      {tab === 'debug' && <FramesTab prompts={prompts} />}
    </div>
  )
}

// ── Agent tab ──────────────────────────────────────────────────────────────

/** The picker (AgentPanel) plus this conversation's live ids — both answer "which agent /
 *  session am I actually on", one for the next chat and one for the open one. */
function AgentTab({ prompts }: { prompts: PromptContent[] }) {
  const id = conversationIdentity(prompts)
  return (
    <div className="cfg">
      <AgentPanel />
      <Section
        title="This conversation"
        sdk="createSession() · streamEvents()"
        caption="Live ids for the open chat, pinned when its first turn ran. Click to copy — there is no public console to link to."
      >
        <IdRow
          label="Agent"
          // A session with no agent id means the marker frame predates carrying one; no
          // session at all means the conversation simply has not started.
          value={id.agentId}
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
      </Section>
    </div>
  )
}

// ── Config tab ─────────────────────────────────────────────────────────────

/**
 * The agent config editor, plus where each field lands upstream.
 *
 * The editor is DISABLED unless the effective agent is one the kit created. That is not
 * decoration: for a borrowed agent (bound or ZOOCLAW_AGENT_ID) the Worker deliberately skips
 * every config PUT (worker/provision.ts), so an editable-looking form would be a form whose
 * changes silently do nothing — and if it did work, it would rewrite somebody else's agent.
 */
function ConfigTab({ hasConversation }: { hasConversation: boolean }) {
  const [config, setConfig] = useAtom(configAtom)
  const eff = useEffectiveAgent()
  // Default to editable while the answer is still loading: the fields render disabled for a
  // beat otherwise, which reads as "broken" rather than "loading".
  const editable = eff.data?.editable ?? true
  const policy = JSON.stringify(buildToolPolicy(config.tools))
  const toolsOn = TOOLS.filter((t) => config.tools[t.key] ?? t.defaultOn)

  return (
    <div className="cfg">
      <SettingsPanel
        config={config}
        onChange={setConfig}
        appliesToNewChat={hasConversation}
        disabledReason={
          editable
            ? null
            : eff.data?.source === 'binding'
              ? 'You are using an agent of your own, so its configuration belongs to it — the kit reads this agent and never writes it. Reset the binding in the Agent tab to edit the kit’s own agent instead.'
              : 'This deployment pins one pre-built agent (ZOOCLAW_AGENT_ID). Its configuration belongs to whoever built it, and the kit never writes it.'
        }
      />

      <Section
        title="Where these land"
        sdk="updateAgent() · putAgentSkill()"
        caption={
          editable
            ? 'Applied to your agent on the first turn of a session — drift-gated, so an unchanged config produces no call at all.'
            : 'Shown for reference. None of these are written while a borrowed agent is in use.'
        }
      >
        <Knob
          name="System prompt"
          value={config.systemPrompt.trim() || '(empty)'}
          where="Config · System prompt"
          lands="PUT /agents/{id} · persona.docs[AGENTS.md]"
          onEdit={editable ? () => jumpTo('sys-prompt') : undefined}
        />
        <Knob
          name="Tools"
          value={toolsOn.length ? toolsOn.map((t) => t.toolName).join(', ') : 'none allowed'}
          where="Config · Tools"
          lands={`PUT /agents/{id} · tool_policy ${policy}`}
          onEdit={editable ? () => jumpTo('agent-tools') : undefined}
        />
        <Knob
          name="Skill"
          value={config.skillId?.trim() || 'none installed'}
          where="Config · Skill ID"
          lands="PUT /agents/{id}/skills/{skill_id} · unpinned, follows the latest ready version"
          onEdit={editable ? () => jumpTo('skill-id') : undefined}
        />
        <p className="cfg-note">
          Applies to the <b>next new chat</b>. The current conversation keeps the config its session was created with, and a config PUT
          bumps <code>config_version</code> on every call, so the kit writes only what actually drifted.
        </p>
      </Section>
    </div>
  )
}

// ── Runtime tab ────────────────────────────────────────────────────────────

function RuntimeTab() {
  const runtime = useConfig()
  return (
    <div className="cfg">
      <Section
        title="Runtime"
        sdk="createZooclawClient()"
        caption="How this deployment is wired. Read-only — it comes from the Worker's environment, so changing it means a redeploy."
      >
        {runtime.isPending && <div className="muted">Loading…</div>}
        {runtime.isError && <div className="cfg-empty">GET /api/app/config failed — the Worker may not be running.</div>}
        {runtime.data && <RuntimeRows config={runtime.data} />}
      </Section>

      <Section title="Not configurable from the kit">
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
      </Section>
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
        name="Agent picker"
        value={r.agentPicker ? 'on — a user may bind an agent of their own' : 'off — everyone uses the deployment’s agent'}
        where="AGENT_PICKER (on by default; set `off` to close it)"
        lands="GET /agents + the binding routes; off → 403 and stored bindings are ignored"
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

/**
 * This conversation's Zooclaw identity, read from the `__zooclaw_session` marker frame the
 * turn runner emits once per session (worker/task-do.ts) — the same source the Debug tab
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

// ── Debug tab (the raw frame inspector) ────────────────────────────────────

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
