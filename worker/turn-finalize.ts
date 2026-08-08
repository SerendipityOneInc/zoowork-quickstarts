/**
 * Pure finalize-decisions for TaskDO.alarm(), factored out so they're unit-testable
 * without instantiating a Durable Object (which imports `cloudflare:workers`).
 *
 * Zooclaw twist: `run.finished` IS the turn's terminal event (the driver reports it), but a
 * window can end without seeing it — the SSE connection dropped, or the window timer fired
 * mid-turn. The session's `status` (a coarse at-rest flag, `idle` when nothing is
 * processing) is the backstop for exactly those windows. Two races follow, and these
 * helpers guard both:
 *
 *  R-a  we POST user.message and poll immediately → the workflow hasn't picked the event
 *       up yet, so status still reads `idle`. Finalizing there drops the whole answer.
 *  R-b  status can flip back to `idle` a beat before the trailing durable events land on
 *       the stream. Finalizing on the bare status there drops the tail of the answer.
 *
 * So an at-rest status only finalizes the turn when the LAST stream window made no
 * progress AND we either already showed text or exhausted the drain budget.
 */

/** Extra no-progress windows tolerated after status reads at-rest, before giving up on
 *  an answer ever arriving (covers R-a's signal latency). */
export const MAX_TERMINAL_DRAINS = 6


/** Statuses that mean the session is at rest (turn over, or never started). `idle` is the
 *  one the docs pin; the rest are defensive vocabulary. */
export const AT_REST_STATUSES = new Set(['idle', 'completed', 'succeeded', 'failed', 'error', 'canceled', 'cancelled', 'archived'])

/** Statuses that map to a FAILED turn (vs. the default completed). */
export const FAILED_STATUSES = new Set(['failed', 'error'])
export const CANCELED_STATUSES = new Set(['canceled', 'cancelled'])

/**
 * Pick the session's at-rest signal out of a `getSession` body — `run_status`, NOT `status`.
 *
 * On `getSession` the ZooClaw API returns `status: null` for every session and puts the outcome in
 * `run_status` (staging-verified 2026-08-07; SDK 0.0.4 types both, and its JSDoc says to prefer
 * `run_status`). Reading `status` made the whole backstop below dead code: it was always nullish,
 * so a window that ended without `run.finished` never finalized on an at-rest session and instead
 * sat until the soft deadline expired.
 *
 * `status` is kept as a fallback because it costs nothing and a deployment that does populate it
 * keeps working. Both nullish → undefined, which `turnExpired` reads as "not positively alive".
 */
export function sessionStatusOf(session: { run_status?: string; status?: string | null } | undefined): string | undefined {
  return session?.run_status ?? session?.status ?? undefined
}

/** `run.finished` carries the run's own outcome enum (the Events reference:
 *  succeeded | failed | aborted) — a DIFFERENT vocabulary from the session status above,
 *  which is why it gets its own mapping. `aborted` is an interrupt, i.e. our 'canceled'. */
export function turnStatusForRun(outcome: string | undefined): string {
  if (outcome === 'failed') return 'failed'
  if (outcome === 'aborted') return 'canceled'
  return 'completed'
}

/** Consecutive failed alarm windows tolerated before the turn is declared dead. One
 *  the ZooClaw API/D1 hiccup between windows must NOT kill a turn whose agent is still running. */
export const MAX_WINDOW_ERRORS = 3

/** HTTP statuses that can never succeed on replay — finalize immediately instead of
 *  burning retry windows. 501 not_configured is the contract's explicit do-NOT-blind-retry;
 *  4xx request/auth/size errors are deterministic. */
const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 413, 501])

/** 409 subtypes with no in-kit self-heal (agent_not_running gets a start kick and IS
 *  retriable; environment conflicts don't occur on the turn path). */
const NO_RETRY_409_TYPES = new Set(['session_archived', 'idempotency_conflict'])

export interface RetryInput {
  errors: number
  now: number
  hardDeadline: number
  /** HTTP status of the caught ZooclawError, when it was one (undefined for network/other). */
  status?: number
  /** the ZooClaw API's error.type, when present. */
  errorType?: string
}

/** True → the window error is worth another alarm; false → give up and finalize 'failed'.
 *  Deterministic upstream rejections (501, plain 4xx, unhealable 409 types) fail fast per
 *  the contract's retry rules; network errors and 5xx get the bounded backoff. */
export function shouldRetryWindowError(i: RetryInput): boolean {
  if (i.status !== undefined) {
    if (NO_RETRY_STATUSES.has(i.status)) return false
    if (i.status === 409 && i.errorType !== undefined && NO_RETRY_409_TYPES.has(i.errorType)) return false
  }
  return i.errors < MAX_WINDOW_ERRORS && i.now < i.hardDeadline
}

/**
 * Turn expiry is two-tier: past the soft deadline we only keep waiting when the session
 * POSITIVELY reports itself alive (a running-ish status) — long tool turns routinely
 * outlive the soft window. An unreachable the ZooClaw API or an at-rest status gets no benefit
 * of the doubt, and the hard deadline caps everything so a hung backend can't pin
 * 'running' forever.
 */
export function turnExpired(i: { now: number; deadline: number; hardDeadline: number; sessionStatus?: string }): boolean {
  const alive = !!i.sessionStatus && !AT_REST_STATUSES.has(i.sessionStatus)
  return i.now >= (alive ? i.hardDeadline : i.deadline)
}

export interface DrainInput {
  /** Did we already stream assistant text this turn? */
  sawText: boolean
  /** Did the LAST stream window yield any new durable events? Progress resets the
   *  finalize decision — an active tail must drain fully (R-b). */
  windowProgressed: boolean
  /** How many no-progress windows we've already drained after seeing an at-rest status. */
  terminalDrains: number
  /** Current time, the turn's soft deadline, and the absolute cap. */
  now: number
  deadline: number
  hardDeadline: number
}

/** True → re-arm one more stream window before finalizing. False → we have the answer
 *  (or exhausted drains / hit the cap): finalize now.
 *
 *  The progressed branch is bounded by the HARD deadline, not the soft one: long tool
 *  turns legitimately outlive the soft deadline (turnExpired keeps them alive while the
 *  status is running-ish), and those are exactly the turns most likely to land a trailing
 *  tail after the status flips at-rest — gating their drain on the soft deadline would
 *  permanently truncate their answers (race R-b). */
export function shouldDrainTerminal(i: DrainInput): boolean {
  if (i.windowProgressed) return i.now < i.hardDeadline // events still flowing — drain the tail
  if (i.now >= i.deadline) return false
  if (i.sawText) return false // quiet window + answer already shown → done
  return i.terminalDrains < MAX_TERMINAL_DRAINS // quiet + no answer yet → wait out R-a
}
