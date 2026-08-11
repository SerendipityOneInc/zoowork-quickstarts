/**
 * The Agent tab: WHICH agent this deployment is talking to, and — when the deployment allows
 * it — a picker to change that to an agent the user already owns in the ZooClaw app.
 *
 * The picker has two modes, and both are first-class:
 *
 *   LIST — the gateway forwards collection-level GET, so `listAgents()` returns the org's
 *          agents and the user picks one.
 *   PASTE — the gateway answers 404 for that route (the state at the time of writing;
 *          FEEDBACK #16), so the tab says so plainly and takes an `agt_…` id instead,
 *          validated through `getAgent()` before it can be saved.
 *
 * Saving binds for the NEXT new chat only. Open conversations stay on the agent they
 * started with — their Zooclaw session exists only there (migrations/0002).
 *
 * Nothing in this tab ever writes an agent's configuration. A borrowed agent belongs to
 * whoever built it; the kit only reads it, and the Config tab goes read-only to say so.
 */
import { useState } from 'react'
import { useMutation, type UseMutationResult } from '@tanstack/react-query'
import { ApiError, getAgent, type AgentSummary, type EffectiveAgent } from '../api.ts'
import { useAgentDirectory, useBindAgent, useEffectiveAgent, useStartAgent, useUnbindAgent } from '../hooks/useAgent.ts'
import { CopyId, Section, StatePill } from './panel-bits.tsx'

/** How the effective agent was chosen, in the panel's words. */
const SOURCE_LABEL: Record<EffectiveAgent['source'], { badge: string; blurb: string }> = {
  binding: { badge: 'bound', blurb: 'You picked this agent. It belongs to you, so the kit only uses it — it never writes its configuration.' },
  'env-fixed': { badge: 'env fixed', blurb: 'ZOOCLAW_AGENT_ID pins one pre-built agent for everyone on this deployment. The kit provisions nothing and writes no configuration.' },
  'per-user': { badge: 'per-user', blurb: 'The kit creates and owns one agent per signed-in user, and applies the Config tab to it on the first turn of each chat.' },
  conversation: { badge: 'pinned', blurb: 'This conversation is pinned to the agent it started on.' },
}

export function AgentPanel() {
  const eff = useEffectiveAgent()
  const agent = eff.data
  const pickerOn = !!agent?.pickerEnabled

  // A fragment, not a `.cfg` of its own: the tab that hosts this also renders the
  // conversation-ids section, and one flex column keeps every card on the same rhythm.
  return (
    <>
      <Section
        title="Agent in use"
        sdk="getAgent() · startAgent()"
        caption="The agent the next new chat will talk to. Open chats keep the agent they started with."
      >
        {eff.isPending && <div className="muted">Loading…</div>}
        {eff.isError && <div className="cfg-empty">GET /api/app/agent failed — the Worker may not be running.</div>}
        {agent && <CurrentAgent agent={agent} />}
      </Section>

      {agent && (
        <Section
          title="Choose an agent"
          sdk="listAgents() · getAgent()"
          caption={
            pickerOn
              ? 'Point this deployment at an agent you already built in the ZooClaw app. Saved choices apply to the next new chat.'
              : undefined
          }
        >
          {pickerOn ? <AgentPicker current={agent} /> : <PickerDisabled />}
        </Section>
      )}
    </>
  )
}

// ── the current agent ──────────────────────────────────────────────────────

function CurrentAgent({ agent }: { agent: EffectiveAgent }) {
  const start = useStartAgent()
  const meta = SOURCE_LABEL[agent.source]
  const stoppable = !!agent.agentId && !!agent.desiredState && agent.desiredState !== 'running'

  return (
    <>
      <div className="agent-head">
        <span className="agent-name">{agent.name || (agent.agentId ? 'unnamed agent' : 'not created yet')}</span>
        <span className="cfg-badge">{meta.badge}</span>
        <StatePill state={agent.desiredState} />
      </div>
      <div className="cfg-id">
        <span className="cfg-name">Agent id</span>
        {agent.agentId ? (
          <CopyId value={agent.agentId} />
        ) : (
          <span className="cfg-value cfg-empty">created on your first message</span>
        )}
      </div>
      <p className="cfg-note">{meta.blurb}</p>

      {agent.lookupError && (
        <div className="agent-alert">
          Could not read this agent: {agent.lookupError.message}
          {agent.source === 'binding' && ' — reset the binding below to fall back to this deployment’s default.'}
        </div>
      )}

      {stoppable && (
        <div className="agent-actions">
          <span className="muted">
            This agent is <b>{agent.desiredState}</b>. A message would fail until it is running.
          </span>
          <button className="primary" disabled={start.isPending} onClick={() => start.mutate(agent.agentId as string)}>
            {start.isPending ? 'Starting…' : 'Start agent'}
          </button>
        </div>
      )}
      {start.isError && <div className="agent-alert">Start failed: {start.error.message}</div>}
    </>
  )
}

function PickerDisabled() {
  return (
    <p className="cfg-note">
      This deployment has closed the picker (<code>AGENT_PICKER=off</code>), so everyone uses the agent it was configured with. It is on by
      default in the kit; a vertical shipping to end users turns it off because <code>ZOOCLAW_API_KEY</code> authenticates the whole
      organization — with it on, any signed-in user can list and borrow any agent in the org.
    </p>
  )
}

// ── the picker ─────────────────────────────────────────────────────────────

function AgentPicker({ current }: { current: EffectiveAgent }) {
  const dir = useAgentDirectory()
  const bind = useBindAgent()
  const unbind = useUnbindAgent()

  // The list's selection is DERIVED, not mirrored: `null` means "whatever is in use", so a
  // bind needs no effect to resync — the new `current.agentId` simply becomes the answer.
  const [picked, setPicked] = useState<string | null>(null)
  const selected = picked ?? current.agentId

  const listed = dir.data?.available ? dir.data.agents : null

  return (
    <>
      {dir.isPending && <div className="muted">Loading agents…</div>}
      {dir.isError && <div className="agent-alert">GET /api/app/agents failed: {dir.error.message}</div>}

      {listed && (
        <>
          <div className="agent-list" role="radiogroup" aria-label="Agents">
            {listed.length === 0 && <div className="cfg-empty">This organization has no agents yet.</div>}
            {listed.map((a) => (
              <AgentRow key={a.agentId} agent={a} checked={selected === a.agentId} onPick={() => setPicked(a.agentId)} />
            ))}
          </div>
          {/* Say what was dropped. A test run is a same-named twin of an agent already in the
              list, so hiding it is right — hiding it silently would make listAgents() look
              like it returned fewer agents than it did. */}
          {dir.data?.available && dir.data.hidden > 0 && <p className="cfg-note">{hiddenNote(dir.data.hidden)}</p>}
          <SaveBinding agentId={selected === current.agentId ? null : selected} bind={bind} />
        </>
      )}

      {dir.data && !dir.data.available && <PasteFallback reason={dir.data} bind={bind} />}

      {bind.isError && <div className="agent-alert">{describeError(bind.error)}</div>}

      {current.source === 'binding' && (
        <div className="agent-actions">
          <button className="ghost" disabled={unbind.isPending} onClick={() => unbind.mutate()}>
            {unbind.isPending ? 'Resetting…' : 'Reset to default'}
          </button>
          <span className="muted">Drops your binding — new chats fall back to this deployment’s own agent.</span>
        </div>
      )}
      {unbind.isError && <div className="agent-alert">Reset failed: {unbind.error.message}</div>}
    </>
  )
}

function hiddenNote(n: number): string {
  return n === 1
    ? '1 Agent Builder test run is hidden — a throwaway copy of an agent already listed above.'
    : `${n} Agent Builder test runs are hidden — throwaway copies of agents already listed above.`
}

/** The commit control, shared by both picker modes. `agentId` is null when there is nothing
 *  to save — no selection yet, or the selection is already the agent in use. */
function SaveBinding({ agentId, bind }: { agentId: string | null; bind: UseMutationResult<EffectiveAgent, Error, string> }) {
  return (
    <div className="agent-actions">
      <button className="primary" disabled={!agentId || bind.isPending} onClick={() => agentId && bind.mutate(agentId)}>
        {bind.isPending ? 'Saving…' : 'Save'}
      </button>
      <span className="muted">Applies to the next new chat.</span>
    </div>
  )
}

function AgentRow({ agent, checked, onPick }: { agent: AgentSummary; checked: boolean; onPick: () => void }) {
  return (
    <label className={`agent-row${checked ? ' picked' : ''}`}>
      <input type="radio" name="agent-pick" checked={checked} onChange={onPick} />
      <span className="agent-row-text">
        <span className="agent-row-head">
          <span className="agent-row-name">{agent.name || 'unnamed agent'}</span>
          <StatePill state={agent.desiredState} />
        </span>
        <span className="agent-row-meta muted mono">
          {agent.agentId}
          {agent.workspaceId && ` · workspace ${agent.workspaceId}`}
        </span>
      </span>
    </label>
  )
}

/**
 * The degraded mode. It states the actual upstream answer rather than hiding a 404 behind an
 * empty list — the list route is genuinely not open yet, and a user who knows that can paste
 * an id and carry on.
 *
 * Validation happens on blur (a `getAgent()` round-trip) so Save is only ever enabled for an
 * id that really resolves, and a wrong paste is explained at the field instead of failing at
 * send time three screens later.
 */
function PasteFallback({
  reason,
  bind,
}: {
  reason: { status: number; code?: string }
  bind: UseMutationResult<EffectiveAgent, Error, string>
}) {
  const [text, setText] = useState('')
  // The check is a mutation, not three hand-synced useStates: `isPending` / `data` / `error`
  // are exactly what a lookup produces, and `reset()` clears all three in one call so
  // "resolved" and "failed" can never both be on screen.
  const check = useMutation({ mutationFn: getAgent })
  const verify = () => {
    const id = text.trim()
    check.reset()
    if (id) check.mutate(id)
  }

  return (
    <>
      <div className="agent-alert">
        The agent list is not available on this deployment: the gateway answered{' '}
        <b>
          {reason.status} {reason.code ?? ''}
        </b>{' '}
        for <code>GET /service/v1/agents</code>. Paste an agent id instead.
      </div>
      <label className="settings-label" htmlFor="agent-paste">
        Agent id
      </label>
      <input
        id="agent-paste"
        className="settings-input mono"
        value={text}
        placeholder="agt_…"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          check.reset()
        }}
        onBlur={verify}
        onKeyDown={(e) => e.key === 'Enter' && verify()}
      />
      {check.isPending && <p className="cfg-note">Checking…</p>}
      {check.data && (
        <div className="agent-head">
          <span className="agent-name">{check.data.name || 'unnamed agent'}</span>
          <StatePill state={check.data.desiredState} />
        </div>
      )}
      {check.error && <div className="agent-alert">{describeError(check.error)}</div>}
      {/* Save only unlocks on an id that actually resolved — a wrong paste is explained at
          the field, not three screens later at send time. */}
      <SaveBinding agentId={check.data?.agentId ?? null} bind={bind} />
    </>
  )
}

/** Surface the server's own explanation, including the hint it attaches when a pasted id
 *  looks like a workspace id — the mistake this field invites most. */
function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.hint ? `${e.message} — ${e.hint}` : e.message
  return e instanceof Error ? e.message : String(e)
}
