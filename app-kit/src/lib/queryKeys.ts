/**
 * Centralised query-key factory. Every React Query key is built here and returns an
 * `as const` tuple; never inline a key array in a component — go through this object so
 * invalidation and key shape stay consistent.
 */
export const queryKeys = {
  me: () => ['me'] as const,
  config: () => ['config'] as const,
  sessions: () => ['sessions'] as const,
  taskContent: (taskId: string) => ['taskContent', taskId] as const,
  /** The agent the NEXT new chat would use (GET /agent). Invalidated by bind/unbind/start. */
  effectiveAgent: () => ['effectiveAgent'] as const,
  /** The org's agent directory (GET /agents) — or its documented unavailable state. */
  agentDirectory: () => ['agentDirectory'] as const,
}

/** Enable conditions for queries whose params may be absent. */
export const queryEnabled = {
  taskContent: (taskId: string | null | undefined) => !!taskId,
}
