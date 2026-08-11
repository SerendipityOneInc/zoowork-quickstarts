/**
 * Turning the ZooClaw API's agent projections into the picker's directory: trim, then drop
 * the rows that are noise. Pure functions, no client, no Env — so the one rule in here that
 * REMOVES data from a user's list is unit-testable (worker/index.ts is not: it re-exports
 * the Durable Object and imports `cloudflare:workers`).
 */
import type { AgentRecord } from '@zooclaw-agents/sdk'
import type { AgentDirectory, AgentSummary } from '../server/routes.ts'

/** Declared labels, with the top-level copy as a fallback — the projection carries both. */
export function labelsOf(a: AgentRecord): Record<string, unknown> {
  const declared = (a.declared ?? {}) as { labels?: unknown }
  return (declared.labels ?? (a as { labels?: unknown }).labels ?? {}) as Record<string, unknown>
}

/**
 * The fat AgentProjection → the four fields the panel renders. Doing this in the Worker is
 * the point: a list response carries every agent's complete persona doc set (kilobytes of
 * somebody's prompt each), and none of it belongs in a browser that needs a name and a state.
 *
 * `workspace_id` is how a user RECOGNISES their agent (it is the first segment of its chat
 * URL), but plenty of agents genuinely have none — the kit's own per-user agents included.
 */
export function toAgentSummary(a: AgentRecord): AgentSummary {
  const declared = (a.declared ?? {}) as { name?: unknown }
  const labels = labelsOf(a)
  return {
    agentId: a.agent_id,
    name: typeof declared.name === 'string' ? declared.name : null,
    workspaceId: typeof labels.workspace_id === 'string' ? labels.workspace_id : null,
    desiredState: typeof a.status?.desired_state === 'string' ? a.status.desired_state : null,
  }
}

/**
 * An Agent Builder TEST RUN. Clicking "try it" in the builder mints a real agent labelled
 * `pack_test_run_id` / `source: agent_builder` — identical name, persona and skills to the
 * pack it was testing, but no workspace and no life past that run. In the picker it appears
 * as a second row with the same name as the agent you actually installed, which is a worse
 * answer than one row.
 *
 * The test is the test-run LABEL, deliberately NOT "has no `workspace_id`": the kit's own
 * per-user agents carry no `workspace_id` either (provision.ts createResourceFor labels them
 * `app` / `user`), so filtering on the absent field would hide exactly the agent a default
 * per-user deployment just created for the person reading the list.
 */
export function isBuilderTestRun(a: AgentRecord): boolean {
  const labels = labelsOf(a)
  return typeof labels.pack_test_run_id === 'string' || labels.source === 'agent_builder'
}

/** The available directory: trimmed rows, plus a COUNT of what was dropped. Reported rather
 *  than silently trimmed — a list that quietly disagrees with `listAgents()` is how a
 *  teaching probe teaches the wrong thing. */
export function toDirectory(all: AgentRecord[]): Extract<AgentDirectory, { available: true }> {
  const shown = all.filter((a) => !isBuilderTestRun(a))
  return { available: true, agents: shown.map(toAgentSummary), hidden: all.length - shown.length }
}
