/**
 * Finalize-decision truth tables for the two Zooclaw races (see turn-finalize.ts):
 * R-a status still `idle` before the workflow picks the event up, R-b status flips
 * `idle` before the tail lands on the stream. Pure; no quota.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldDrainTerminal, shouldRetryWindowError, turnExpired, sessionStatusOf, AT_REST_STATUSES, MAX_TERMINAL_DRAINS, MAX_WINDOW_ERRORS } from './turn-finalize.ts'

test('shouldDrainTerminal: a progressed window always drains again — even with text shown (R-b)', () => {
  const base = { sawText: false, windowProgressed: false, terminalDrains: 0, now: 0, deadline: 1000, hardDeadline: 2000 }
  assert.equal(shouldDrainTerminal({ ...base, windowProgressed: true }), true)
  assert.equal(shouldDrainTerminal({ ...base, windowProgressed: true, sawText: true }), true) // an active tail outranks "answer shown"
})

test('shouldDrainTerminal: an active tail drains past the SOFT deadline (long-turn R-b), bounded by the hard cap', () => {
  // Long tool turns legitimately outlive the soft deadline; their trailing tail must
  // still drain or the answer is permanently truncated.
  const base = { sawText: true, windowProgressed: true, terminalDrains: 0, deadline: 1000, hardDeadline: 2000 }
  assert.equal(shouldDrainTerminal({ ...base, now: 1500 }), true) // past soft — still drains
  assert.equal(shouldDrainTerminal({ ...base, now: 2000 }), false) // hard cap bounds everything
})

test('shouldDrainTerminal: quiet window + text already shown → finalize now', () => {
  assert.equal(shouldDrainTerminal({ sawText: true, windowProgressed: false, terminalDrains: 0, now: 0, deadline: 1000, hardDeadline: 2000 }), false)
})

test('shouldDrainTerminal: quiet + no text yet → keep waiting out R-a until the drain budget runs dry', () => {
  const base = { sawText: false, windowProgressed: false, now: 0, deadline: 1000, hardDeadline: 2000 }
  assert.equal(shouldDrainTerminal({ ...base, terminalDrains: 0 }), true)
  assert.equal(shouldDrainTerminal({ ...base, terminalDrains: MAX_TERMINAL_DRAINS - 1 }), true)
  assert.equal(shouldDrainTerminal({ ...base, terminalDrains: MAX_TERMINAL_DRAINS }), false) // budget exhausted → give up
})

test('shouldDrainTerminal: the soft deadline caps QUIET waiting (only progress earns more)', () => {
  const quiet = { sawText: false, windowProgressed: false, terminalDrains: 0, deadline: 1000, hardDeadline: 2000 }
  assert.equal(shouldDrainTerminal({ ...quiet, now: 1000 }), false)
  assert.equal(shouldDrainTerminal({ ...quiet, now: 1500 }), false)
})

test('turnExpired: a running-ish status earns the hard deadline', () => {
  assert.equal(turnExpired({ now: 50, deadline: 100, hardDeadline: 200, sessionStatus: 'running' }), false)
  assert.equal(turnExpired({ now: 150, deadline: 100, hardDeadline: 200, sessionStatus: 'running' }), false) // past soft, before hard
  assert.equal(turnExpired({ now: 250, deadline: 100, hardDeadline: 200, sessionStatus: 'running' }), true) // hard cap bounds even alive
})

test('turnExpired: idle / absent status gets only the soft deadline', () => {
  assert.equal(turnExpired({ now: 50, deadline: 100, hardDeadline: 200, sessionStatus: 'idle' }), false)
  assert.equal(turnExpired({ now: 150, deadline: 100, hardDeadline: 200, sessionStatus: 'idle' }), true)
  assert.equal(turnExpired({ now: 150, deadline: 100, hardDeadline: 200 }), true) // unreachable the ZooClaw API: no benefit of the doubt
  assert.equal(turnExpired({ now: 150, deadline: 100, hardDeadline: 200, sessionStatus: 'failed' }), true) // any at-rest status
})

test('turnExpired: unknown non-at-rest vocabulary is treated alive (hard deadline)', () => {
  assert.equal(turnExpired({ now: 150, deadline: 100, hardDeadline: 200, sessionStatus: 'reticulating' }), false)
  assert.equal(turnExpired({ now: 250, deadline: 100, hardDeadline: 200, sessionStatus: 'reticulating' }), true)
})

test('shouldRetryWindowError: bounded by error count and the hard deadline', () => {
  assert.equal(shouldRetryWindowError({ errors: 1, now: 0, hardDeadline: 100 }), true)
  assert.equal(shouldRetryWindowError({ errors: MAX_WINDOW_ERRORS - 1, now: 0, hardDeadline: 100 }), true)
  assert.equal(shouldRetryWindowError({ errors: MAX_WINDOW_ERRORS, now: 0, hardDeadline: 100 }), false)
  assert.equal(shouldRetryWindowError({ errors: 1, now: 100, hardDeadline: 100 }), false)
})

test('shouldRetryWindowError: deterministic upstream rejections fail fast (contract retry rules)', () => {
  const base = { errors: 1, now: 0, hardDeadline: 100 }
  // 501 not_configured is the contract's explicit do-NOT-blind-retry; plain 4xx are deterministic.
  for (const status of [400, 401, 403, 404, 413, 501]) {
    assert.equal(shouldRetryWindowError({ ...base, status }), false, `status ${status} must not retry`)
  }
  // Unhealable 409 subtypes can never succeed on replay.
  assert.equal(shouldRetryWindowError({ ...base, status: 409, errorType: 'session_archived' }), false)
  assert.equal(shouldRetryWindowError({ ...base, status: 409, errorType: 'idempotency_conflict' }), false)
  // agent_not_running got a start kick before the rethrow — retriable; so are 5xx/429/network.
  assert.equal(shouldRetryWindowError({ ...base, status: 409, errorType: 'agent_not_running' }), true)
  assert.equal(shouldRetryWindowError({ ...base, status: 409 }), true) // unknown 409 subtype: benefit of the doubt
  assert.equal(shouldRetryWindowError({ ...base, status: 500 }), true)
  assert.equal(shouldRetryWindowError({ ...base, status: 429 }), true)
  assert.equal(shouldRetryWindowError({ ...base }), true) // network error: no status
})

test('sessionStatusOf reads run_status — `status` is null on every getSession', () => {
  // The regression this pins: reading `status` made the at-rest backstop dead code. Staging
  // returns the outcome in `run_status` and `status: null` on the same body, so a test that
  // only fed `{status}` would have passed while production never finalized on this path.
  assert.equal(sessionStatusOf({ run_status: 'succeeded', status: null }), 'succeeded')
  assert.ok(AT_REST_STATUSES.has(sessionStatusOf({ run_status: 'succeeded', status: null })!))

  // A deployment that populates `status` instead still works.
  assert.equal(sessionStatusOf({ status: 'idle' }), 'idle')
  // run_status wins when both are real.
  assert.equal(sessionStatusOf({ run_status: 'failed', status: 'idle' }), 'failed')

  // Nothing to go on → undefined, which turnExpired reads as "not positively alive", so the
  // turn expires on the SOFT deadline rather than being granted the hard cap.
  assert.equal(sessionStatusOf({}), undefined)
  assert.equal(sessionStatusOf({ status: null }), undefined)
  assert.equal(sessionStatusOf(undefined), undefined)
  assert.equal(turnExpired({ now: 100, deadline: 50, hardDeadline: 999, sessionStatus: sessionStatusOf({ status: null }) }), true)
})
