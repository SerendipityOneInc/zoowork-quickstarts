/**
 * TaskDO — the per-task turn runner, an ALARM-DRIVEN Durable Object (one per taskId). The
 * CF-welded execution leg: a turn streams the ZooClaw API's session event stream for minutes,
 * but `ctx.waitUntil` does NOT keep a DO alive past the request, so the turn lives in
 * alarm() and advances in bounded windows; progress (sessionId, lastEventSeq, …) is
 * persisted in DO storage so a resumed alarm continues idempotently.
 *
 *   runTurn() → persist intent + setAlarm(now)   (rejected if a turn is in flight)
 *   alarm()   → ensure agent + session → submit user.message → driveTurn one stream
 *               window → frames(store) → finalize when the session settles (or expire)
 *
 * The streaming itself (translate, resume cursor) lives in the shared driveTurn
 * (server/zooclaw/turn-driver.ts); this file is just the execution leg + finalize/recover
 * bookkeeping. Swapping CF for another long-lived runtime rewrites THIS file (+ the SSE
 * carrier); the streaming contract is untouched (template-layering ②).
 *
 * TURN-END: `run.finished` is the authoritative boundary and the driver reports it
 * (`end.terminal`). The session-status poll below is the BACKSTOP for a window that ended
 * without seeing it — dropped SSE connection, window timer, idle short-circuit: an at-rest
 * status (`idle`) + a no-progress window + (answer shown OR drain budget spent) finalizes
 * the turn. See worker/turn-finalize.ts for the two races that guards. Because the stream
 * is session-scoped and never closes at turn end, each window also carries an IDLE
 * short-circuit (abort after a few quiet seconds) so a finished answer doesn't wait out
 * the full window.
 *
 * OWNERSHIP DISCIPLINE: cancel() and a follow-up runTurn() can land while alarm() is
 * suspended on outbound I/O (DO input gates only close during ctx.storage ops). Every
 * write of the 'turn' key therefore goes through putTurnIfOwned(), and finalize()
 * re-verifies ownership — a canceled/replaced turn's in-flight alarm must never
 * resurrect state it no longer owns, post its message after the user canceled, or
 * overwrite a 'canceled' verdict with 'completed'.
 */
import { DurableObject } from 'cloudflare:workers'
import { createD1Store } from '../server/store-d1.ts'
import type { Store } from '../server/store.ts'
import { messageText, ZooclawError, type ZooclawClient, type SessionHistoryEntry } from '@zooclaw-agents/sdk'
import { driveTurn, alreadyEmitted, recordEmitted, type FrameSink, type TurnEnd } from '../server/zooclaw/turn-driver.ts'
import {
  shouldDrainTerminal,
  shouldRetryWindowError,
  turnExpired,
  turnStatusForRun,
  AT_REST_STATUSES,
  FAILED_STATUSES,
  CANCELED_STATUSES,
} from './turn-finalize.ts'
import { framesHaveAssistantText } from '../server/frame-text.ts'
import { agentFor } from './provision.ts'
import { defaultAgentConfig, type AgentConfig } from '../domain/agent.ts'
import { provisionConfig, zooclawClient, type Env } from './env.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

const TURN_TIMEOUT_MS = 240_000 // soft ceiling: past this, only a session that REPORTS itself alive keeps going
const TURN_HARD_CAP_MS = 900_000 // absolute ceiling, even with the session alive
const WINDOW_MS = 20_000 // per-alarm streaming window — short enough to never risk eviction
const FIRST_EVENT_IDLE_MS = 8_000 // quiet time tolerated before the window's FIRST event
const EVENT_IDLE_MS = 2_500 // quiet time after an event before the window short-circuits

/** The in-flight turn, persisted in DO storage so alarm() resumes idempotently. The
 *  conversation's Zooclaw ids live separately ('agentId'/'sessionId') so follow-ups
 *  continue the same session. */
interface TurnState {
  taskId: string
  promptId: string
  prompt: string
  userEmail: string
  /** Session agent config (persona + tool toggles + skill pin), applied to the user's
   *  agent on the first turn. Carried from the UI via runTurn. */
  agentConfig?: AgentConfig
  agentId?: string
  sessionId?: string
  /** Did this turn already create the session / post its user.message? Guards a retried
   *  alarm from double-sending. */
  submitted: boolean
  /** Highest durable session-event seq processed — resume cursor across windows. Zooclaw
   *  seqs are SESSION-scoped (they don't reset per turn), so this is seeded from the DO's
   *  persisted 'sessionSeq' at submit time — starting a follow-up turn at 0 would replay
   *  the whole conversation's events into the new turn's frames. */
  lastEventSeq: number
  /** Exact-match ledger of assistant text shown (see turn-driver recordEmitted), so a
   *  re-delivered final message isn't doubled across windows. */
  emittedText: string
  terminalDrains: number
  deadline: number
  hardDeadline: number
  errors: number
}

export class TaskDO extends DurableObject<Env> {
  private store: Store = createD1Store(this.env.DB)
  /** Durable frame seq for the current window (read from the store at window start). */
  private frameSeq = 0

  private client(): ZooclawClient {
    return zooclawClient(this.env)
  }

  private emit(promptId: string, data: Record<string, unknown>): Promise<void> {
    return this.store.appendFrame(promptId, ++this.frameSeq, data)
  }
  private async maxFrameSeq(promptId: string): Promise<number> {
    const frames = await this.store.framesSince(promptId, 0)
    return frames.length ? frames[frames.length - 1]!.seq : 0
  }
  /** Emit assistant text once, deduped (exact-match ledger, shared with driveTurn)
   *  against what this turn already showed. */
  private async emitAnswer(t: TurnState, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    const ref = { value: t.emittedText }
    if (alreadyEmitted(ref, trimmed)) return
    await this.emit(t.promptId, { type: 'assistant', message: { content: [{ type: 'text', text: trimmed }] } })
    recordEmitted(ref, trimmed)
    t.emittedText = ref.value
  }

  /** Map the SESSION's at-rest status (the backstop path) to a turn verdict. The terminal
   *  path uses turnStatusForRun instead — `run.finished` speaks a different enum. */
  private mapStatus(sessionStatus: string | undefined): string {
    if (sessionStatus && FAILED_STATUSES.has(sessionStatus)) return 'failed'
    if (sessionStatus && CANCELED_STATUSES.has(sessionStatus)) return 'canceled'
    return 'completed'
  }

  /** Last-ditch: finalizing without ever showing text means the answer exists upstream but
   *  never became a frame. Pull the newest answer out of the transcript so the LIVE view
   *  completes too (recoverPrompt does the same on a later refresh). Best-effort. */
  private async backfillLastAnswer(t: TurnState, client: ZooclawClient, agentId: string, sessionId: string): Promise<void> {
    const session = await client.getSession(agentId, sessionId, { history: true, limit: 50 }).catch(() => null)
    const history = session?.history
    if (!Array.isArray(history)) return
    const buckets = this.answerBuckets(history)
    for (const text of buckets[buckets.length - 1] ?? []) await this.emitAnswer(t, text)
  }

  // ── ownership guards (see header: OWNERSHIP DISCIPLINE) ────────────────────
  /** The persisted turn, only if it is still THIS turn (same promptId). */
  private async ownedTurn(promptId: string): Promise<TurnState | undefined> {
    const cur = await this.ctx.storage.get<TurnState>('turn')
    return cur && cur.promptId === promptId ? cur : undefined
  }
  /** Persist turn state only if this turn still owns the key. False → a cancel() or a
   *  replacing runTurn() won the race; the caller must stop driving immediately. */
  private async putTurnIfOwned(t: TurnState): Promise<boolean> {
    if (!(await this.ownedTurn(t.promptId))) return false
    await this.ctx.storage.put('turn', t)
    return true
  }

  /** Finalize THIS turn: prompt status (running-only write), then the task status —
   *  but only when our prompt write actually won (a cancel() that already finalized
   *  'canceled' must not be overwritten by a late 'completed'). */
  private async finalize(t: TurnState, status: string): Promise<void> {
    await this.store.finishPrompt(t.promptId, status) // no-op if already non-running
    const p = await this.store.getPrompt(t.promptId)
    if (p?.status === status) await this.store.setTaskStatus(t.taskId, status)
    if (await this.ownedTurn(t.promptId)) {
      await this.ctx.storage.delete('turn')
      await this.ctx.storage.deleteAlarm()
    }
  }

  /** Best-effort: advance the conversation cursor to the session's current head, so a
   *  turn that ends EARLY (cancel / expiry / give-up) doesn't leave the cursor behind
   *  output the backend is still flushing — the next turn would replay that late output
   *  into its own bubble. Narrows the race; events that land after this snapshot are
   *  still possible and accepted. */
  private async advanceSessionCursor(agentId: string, sessionId: string): Promise<void> {
    try {
      let cur = (await this.ctx.storage.get<number>('sessionSeq')) ?? 0
      for (let page = 0; page < 4; page++) {
        const events = await this.client().listEvents(agentId, sessionId, { after: cur, limit: 500 })
        for (const ev of events) if (ev.seq > cur) cur = ev.seq
        await this.ctx.storage.put('sessionSeq', cur)
        if (events.length < 500) return
      }
    } catch {
      /* cursor advance is an optimization — never block finalize on it */
    }
  }

  // ── RPC surface (called from the Worker via env.TASK_DO.getByName(taskId)) ──
  /** Persist the turn intent and fire the alarm; returns false (and does nothing) when
   *  another prompt's turn is still in flight — the caller surfaces 409 and must mark
   *  the rejected prompt failed, otherwise it would sit 'running' forever. */
  async runTurn(taskId: string, promptId: string, prompt: string, userEmail = '', agentConfig?: AgentConfig): Promise<boolean> {
    const existing = await this.ctx.storage.get<TurnState>('turn')
    if (existing && existing.promptId !== promptId) return false
    const t: TurnState = {
      taskId,
      promptId,
      prompt,
      userEmail,
      agentConfig,
      submitted: false,
      lastEventSeq: 0,
      emittedText: '',
      terminalDrains: 0,
      deadline: Date.now() + TURN_TIMEOUT_MS,
      hardDeadline: Date.now() + TURN_HARD_CAP_MS,
      errors: 0,
    }
    await this.ctx.storage.put('turn', t)
    await this.ctx.storage.setAlarm(Date.now())
    return true
  }

  /** Re-arm the alarm NOW so the next streaming window runs immediately — called after a
   *  tool confirmation is answered, so the resumed turn's reply streams in without
   *  waiting out the current poll interval. No-op if the turn already finalized. */
  async nudge(): Promise<void> {
    if (await this.ctx.storage.get<TurnState>('turn')) await this.ctx.storage.setAlarm(Date.now())
  }

  /** Cancel the in-flight turn: hard-cancel the backend run (user.interrupt, best-effort
   *  — no in-flight run just comes back accepted:false), advance the cursor past any
   *  late output, and finalize locally. The mid-flight alarm sees ownership gone at its
   *  next guarded write and stops. */
  async cancel(promptId: string): Promise<boolean> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t || t.promptId !== promptId) return false
    const agentId = t.agentId ?? (await this.ctx.storage.get<string>('agentId'))
    const sessionId = t.sessionId ?? (await this.ctx.storage.get<string>('sessionId'))
    if (agentId && sessionId) {
      await this.client()
        .postEvents(agentId, sessionId, [{ type: 'user.interrupt' }])
        .catch(() => {
          /* best-effort: local cancel must not depend on the ZooClaw API availability */
        })
      await this.advanceSessionCursor(agentId, sessionId)
    }
    await this.finalize(t, 'canceled')
    return true
  }

  // ── self-heal (R3): make a refresh-only reader see the complete answer ──
  private async backfillText(promptId: string, texts: string[]): Promise<void> {
    let seq = await this.maxFrameSeq(promptId)
    for (const text of texts) {
      await this.store.appendFrame(promptId, ++seq, { type: 'assistant', message: { content: [{ type: 'text', text }] } })
    }
  }

  /** Assistant texts per user turn, folded from the session transcript: each user
   *  message opens a bucket; assistant texts fall into the current bucket. Lets the
   *  recover path map "the kit's Nth prompt" → "the answer to the Nth user message". */
  private answerBuckets(history: SessionHistoryEntry[]): string[][] {
    const buckets: string[][] = []
    for (const row of history) {
      if (row.entry_type !== 'message' || !isObj(row.entry)) continue
      const msg = isObj(row.entry.message) ? row.entry.message : undefined
      if (!msg) continue
      const role = typeof msg.role === 'string' ? msg.role : ''
      const text = messageText(msg)
      if (role === 'user') buckets.push([])
      else if (role === 'assistant' && text.trim() && buckets.length) buckets[buckets.length - 1]!.push(text.trim())
    }
    return buckets
  }

  /** Self-heal a finalized turn whose answer never rendered, by backfilling it from the
   *  session transcript, so a browser refresh (which reads only the store) shows the
   *  complete message. Canceled turns are skipped (no answer is expected). A FAILED
   *  attempt appends a __heal_attempted marker frame — the content route stops asking
   *  after a couple of those, so an unhealable turn can't turn every page load into an
   *  upstream transcript read (the service token is shared; amplification here is a
   *  cross-tenant availability risk). */
  async recoverPrompt(promptId: string): Promise<boolean> {
    const p = await this.store.getPrompt(promptId)
    if (!p || p.status === 'running' || p.status === 'canceled') return false // live turns own their frames; canceled turns have no answer
    const frames = await this.store.framesSince(promptId, 0)
    if (framesHaveAssistantText(frames)) return false

    const markFailed = async (): Promise<false> => {
      this.frameSeq = await this.maxFrameSeq(promptId)
      await this.emit(promptId, { __heal_attempted: true })
      return false
    }

    let agentId = await this.ctx.storage.get<string>('agentId')
    let sessionId = await this.ctx.storage.get<string>('sessionId')
    if (!sessionId) sessionId = (await this.store.getTask(p.task_id))?.session_id ?? undefined
    if (!agentId || !sessionId) return markFailed()
    const ordered = await this.store.listPrompts(p.task_id)
    const idx = ordered.findIndex((row) => row.id === promptId)
    if (idx < 0) return markFailed()
    const session = await this.client()
      .getSession(agentId, sessionId, { history: true, limit: 500 })
      .catch(() => null)
    const history = session?.history
    if (!Array.isArray(history)) return markFailed()
    const buckets = this.answerBuckets(history)
    // Only trust the mapping when the transcript shows the same number of user turns as
    // the kit does — anything else (truncated history tail, channel-injected messages)
    // makes the index ambiguous.
    if (buckets.length !== ordered.length) return markFailed()
    const texts = buckets[idx] ?? []
    if (!texts.length) return markFailed()
    await this.backfillText(promptId, texts)
    await this.unfailRecovered(p)
    return true
  }

  /** A 'failed' verdict was premature if the answer later proved recoverable. Flip the
   *  prompt back to 'completed'; the task too, but only when this is its latest turn. */
  private async unfailRecovered(p: { id: string; task_id: string; status: string }): Promise<void> {
    if (p.status !== 'failed') return
    await this.store.setPromptStatus(p.id, 'completed')
    const all = await this.store.listPrompts(p.task_id)
    if (all[all.length - 1]?.id === p.id) await this.store.setTaskStatus(p.task_id, 'completed')
  }

  /** Drive one bounded window of the turn, then either finalize or re-arm the alarm. */
  async alarm(): Promise<void> {
    const t = await this.ctx.storage.get<TurnState>('turn')
    if (!t) return // canceled / already finalized
    const client = this.client()

    try {
      if (!t.submitted) {
        // One Zooclaw session per CONVERSATION: the first turn creates it (with the
        // prompt as initial user.message); follow-ups post events into it.
        let agentId = await this.ctx.storage.get<string>('agentId')
        let sessionId = await this.ctx.storage.get<string>('sessionId')
        if (!sessionId) sessionId = (await this.store.getTask(t.taskId))?.session_id ?? undefined

        if (!agentId) {
          // Provision (or reuse) this user's agent and apply this session's agent config.
          const provisioned = await agentFor(this.store, client, t.userEmail, provisionConfig(this.env), t.agentConfig ?? defaultAgentConfig())
          agentId = provisioned.agentId
          await this.ctx.storage.put('agentId', agentId)
        }

        // Last ownership check before the outbound send: a cancel() during the (long)
        // provisioning awaits must stop the message from being posted at all.
        if (!(await this.ownedTurn(t.promptId))) return

        // Seed the resume cursor from the conversation's persisted tail: session seqs
        // are durable across turns, and everything at or before the tail was already
        // rendered by earlier turns (our just-posted user.message lands after it and is
        // skipped as a user_echo).
        t.lastEventSeq = (await this.ctx.storage.get<number>('sessionSeq')) ?? 0

        try {
          if (!sessionId) {
            const session = await client.createSession(
              agentId,
              {
                initial_events: [{ type: 'user.message', content: t.prompt }],
                metadata: { app: 'zooclaw-app-kit', task_id: t.taskId },
              },
              `zooclaw-app-kit:turn:${t.promptId}`,
            )
            sessionId = session.session_id
            await this.ctx.storage.put('sessionId', sessionId)
            await this.store.setTaskSessionId(t.taskId, sessionId)
          } else {
            const ack = await client.postEvents(agentId, sessionId, [{ type: 'user.message', content: t.prompt }])
            // Fast cursor: when the 202 echoes our event's seq as a numeric id, everything
            // BEFORE our message belongs to earlier turns — skip it wholesale. This also
            // absorbs any late output a canceled/expired previous turn flushed after its
            // cursor snapshot.
            const firstId = Number(ack.events[0]?.id)
            if (Number.isFinite(firstId) && firstId > 0) t.lastEventSeq = Math.max(t.lastEventSeq, firstId - 1)
          }
        } catch (e) {
          // The one recoverable submit failure: the agent isn't running (stopped between
          // turns / first start still settling). Kick a start and let the normal window
          // retry re-submit — session create is idempotent (key = promptId), and the
          // user.message double-send window on a lost 202 is accepted (see README).
          if (e instanceof ZooclawError && e.status === 409 && e.type === 'agent_not_running') {
            await client.startAgent(agentId).catch(() => {})
          }
          throw e
        }

        t.agentId = agentId
        t.sessionId = sessionId
        t.submitted = true
        if (!(await this.putTurnIfOwned(t))) return // canceled during submit — interrupt already covers the sent message
        // Surface this conversation's session id so the debug pane can show it.
        this.frameSeq = await this.maxFrameSeq(t.promptId)
        await this.emit(t.promptId, { __zooclaw_session: sessionId })
      }

      const { agentId, sessionId } = t
      if (!agentId || !sessionId) {
        await this.emit(t.promptId, { __error: 'Internal error: the ZooClaw session is missing.' })
        return this.finalize(t, 'failed')
      }

      // Drive one bounded streaming window through the shared driver. The stream is
      // session-scoped and never closes at turn end, so the window carries TWO abort
      // timers: the hard WINDOW_MS cap, and an idle short-circuit (reset on every emitted
      // frame) so a finished answer proceeds to the status poll within seconds instead of
      // idling out the full window.
      this.frameSeq = await this.maxFrameSeq(t.promptId)
      const abort = new AbortController()
      const hardTimer = setTimeout(() => abort.abort(), WINDOW_MS)
      let idleTimer = setTimeout(() => abort.abort(), FIRST_EVENT_IDLE_MS)
      const sink: FrameSink = {
        emit: (data) => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => abort.abort(), EVENT_IDLE_MS)
          return this.emit(t.promptId, data)
        },
      }
      const emittedRef = { value: t.emittedText }
      const end: TurnEnd = await driveTurn(client, agentId, sessionId, sink, {
        after: t.lastEventSeq,
        signal: abort.signal,
        emittedText: emittedRef,
      }).finally(() => {
        clearTimeout(hardTimer)
        clearTimeout(idleTimer)
      })

      const progressed = end.lastSeq > t.lastEventSeq
      if (progressed) t.terminalDrains = 0 // events still flowing → reset the drain budget
      t.lastEventSeq = end.lastSeq
      t.emittedText = emittedRef.value
      if (!end.streamError) t.errors = 0 // a clean window ran — the ZooClaw API is reachable

      // Persist progress BEFORE acting on errors or polling status: frames this window
      // wrote are already durable, so losing the cursor would duplicate them on retry.
      // The conversation-level cursor is monotonic and safe to advance even if ownership
      // was lost mid-window; the turn key itself is ownership-guarded.
      await this.ctx.storage.put('sessionSeq', t.lastEventSeq)
      if (!(await this.putTurnIfOwned(t))) return // canceled/replaced mid-window — stop driving
      if (end.streamError) throw end.streamError // progress saved; classify below

      if (end.terminal) {
        // `run.finished` — the authoritative turn boundary. A succeeded run that produced
        // no visible text still owes the user an answer; pull it from the transcript.
        if (!t.emittedText.length && end.status !== 'aborted') await this.backfillLastAnswer(t, client, agentId, sessionId)
        return this.finalize(t, turnStatusForRun(end.status))
      }

      // Window ended without a terminal event (the normal case). Ask the session's status.
      const st = await client.getSession(agentId, sessionId).catch(() => ({}) as { status?: string })
      const status = st.status

      if (status && AT_REST_STATUSES.has(status)) {
        const sawText = t.emittedText.length > 0
        if (
          shouldDrainTerminal({
            sawText,
            windowProgressed: progressed,
            terminalDrains: t.terminalDrains,
            now: Date.now(),
            deadline: t.deadline,
            hardDeadline: t.hardDeadline,
          })
        ) {
          if (!progressed) t.terminalDrains++
          if (!(await this.putTurnIfOwned(t))) return
          await this.ctx.storage.setAlarm(Date.now() + 500)
          return
        }
        if (!sawText) await this.backfillLastAnswer(t, client, agentId, sessionId)
        return this.finalize(t, this.mapStatus(status))
      }

      // Two-tier expiry: an alive session keeps the turn going to the hard cap; an
      // unreachable/at-rest one doesn't.
      if (turnExpired({ now: Date.now(), deadline: t.deadline, hardDeadline: t.hardDeadline, sessionStatus: status })) {
        await this.advanceSessionCursor(agentId, sessionId) // don't let the late answer replay into the next turn
        await this.emit(t.promptId, { __error: 'Timed out waiting for this turn. The result may still land - reload the page to pick it up.' })
        return this.finalize(t, 'failed')
      }

      if (!(await this.putTurnIfOwned(t))) return
      await this.ctx.storage.setAlarm(Date.now() + 100)
    } catch (e: unknown) {
      // A transient hiccup must not kill a turn whose agent is still running. Retry with
      // backoff — but deterministic upstream rejections (501 not_configured, plain 4xx,
      // unhealable 409 types) fail fast per the contract's retry rules.
      const status = e instanceof ZooclawError ? e.status : undefined
      const errorType = e instanceof ZooclawError ? e.type : undefined
      const errors = (t.errors ?? 0) + 1
      if (shouldRetryWindowError({ errors, now: Date.now(), hardDeadline: t.hardDeadline, status, errorType })) {
        t.errors = errors
        if (!(await this.putTurnIfOwned(t))) return
        await this.ctx.storage.setAlarm(Date.now() + 1500 * errors)
        return
      }
      if (t.agentId && t.sessionId) await this.advanceSessionCursor(t.agentId, t.sessionId)
      const friendly =
        e instanceof ZooclawError && e.status >= 500 && e.status !== 501
          ? `The upstream service is temporarily unavailable (${e.status}). Try again shortly.`
          : e instanceof ZooclawError && e.status === 501
            ? 'This deployment does not have that capability wired up (501 not_configured).'
            : e instanceof Error
              ? e.message
              : String(e)
      await this.emit(t.promptId, { __error: friendly })
      await this.finalize(t, 'failed')
    }
  }
}
