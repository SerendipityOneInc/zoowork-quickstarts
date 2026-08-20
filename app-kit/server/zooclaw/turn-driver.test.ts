/**
 * Turn-driver tests: the pure translate truth table (one frame vocabulary for every
 * downstream renderer), then driveTurn against a fake ZooclawClient.
 *
 * The event fixtures below are real payload shapes, captured from a live session
 * stream. An earlier version of this file asserted a guessed vocabulary — `agent.message`,
 * `tool.call`, `run.completed` — none of which the API emits, which is exactly why every
 * event used to fall through to the debug branch and the UI rendered nothing.
 *
 * The driver contract under test: frames flow in order, plumbing events don't become
 * content, a re-carried final text is deduped via the caller-persisted emittedText ref
 * ACROSS windows, `run.finished` ends the turn with its own status enum, and resume rides
 * OPAQUE TOKENS: the newest `ev.cursor` comes back on TurnEnd and goes in as `{ cursor }`
 * (never the deprecated numeric `after`), while a caller restored from pre-token state
 * streams cursorless and skips through the stored seq — earning its first token even from
 * a skipped event.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate, driveTurn, type FrameData, type FrameSink } from './turn-driver.ts'
import type { SessionEvent, ZooclawClient } from '@zooclaw-agents/sdk'

const ev = (seq: number, eventType: string, payload: Record<string, unknown> = {}): SessionEvent => ({ seq, eventType, payload })

const assistant = (seq: number, text: string): SessionEvent => ev(seq, 'agent.assistant', { segment: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })

/** Stamp the server-minted resume token a streamed event carries. Opaque by contract —
 *  the fixture strings just need to be recognizable, not derivable. */
const tok = (e: SessionEvent, cursor: string): SessionEvent => ({ ...e, cursor })

/** ZooclawClient double exposing ONLY streamEvents (all driveTurn touches). Each call
 *  serves the next window's events and records the resume token it was handed — and
 *  proves the deprecated `after` lane is never selected. */
function fakeClient(...windows: SessionEvent[][]): { client: ZooclawClient; cursors: (string | undefined)[] } {
  const cursors: (string | undefined)[] = []
  let w = 0
  const client = {
    async *streamEvents(_agentId: string, _sessionId: string, opts: { after?: number; cursor?: string } = {}) {
      assert.equal(opts.after, undefined, 'the deprecated after lane must never be passed')
      cursors.push(opts.cursor)
      for (const e of windows[w] ?? []) yield e
      w++
    },
  } as unknown as ZooclawClient
  return { client, cursors }
}

function arraySink(): { frames: FrameData[]; sink: FrameSink } {
  const frames: FrameData[] = []
  return { frames, sink: { emit: (d) => void frames.push(d) } }
}
const kindsOf = (frames: FrameData[]): unknown[] => frames.map((d) => d.type ?? d.__zooclaw ?? (d.__error !== undefined ? '__error' : undefined))

test('translate: assistant text comes out of payload.message.content[]', () => {
  assert.deepEqual(translate(assistant(1, 'hi')), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }])
  assert.deepEqual(translate(assistant(1, '   ')), []) // blank text renders nothing
  // several text blocks in one event concatenate (the SDK's assistantText joins them)
  const multi = ev(2, 'agent.assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'b' }] } })
  assert.deepEqual(translate(multi), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'ab' }] } }])
})

test('translate: thinking is a debug frame, not chat content', () => {
  assert.deepEqual(translate(ev(1, 'agent.thinking', { contentIndex: 0, text: 'hmm' })), [{ __zooclaw: 'thinking', payload: { text: 'hmm' } }])
  assert.deepEqual(translate(ev(1, 'agent.thinking', { text: ' ' })), [])
})

test('translate: one tool call is two events paired by toolCallId', () => {
  assert.deepEqual(translate(ev(1, 'agent.tool', { phase: 'start', toolCallId: 'toolu_01', toolName: 'bash', args: { command: 'ls' } })), [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01', name: 'bash', input: { command: 'ls' } }] } },
  ])
  assert.deepEqual(translate(ev(2, 'agent.tool', { phase: 'end', toolCallId: 'toolu_01', toolName: 'bash', isError: false, resultPreview: 'a\nb' })), [
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'a\nb', is_error: false }] } },
  ])
  // `blocked` means waiting on an approval — the call has NOT run, so it must not render a
  // result. An `end` still follows once the approval resolves.
  assert.deepEqual(translate(ev(3, 'agent.tool', { phase: 'blocked', toolCallId: 'toolu_01', toolName: 'bash' })), [
    { __zooclaw: 'tool_blocked', payload: { toolCallId: 'toolu_01', toolName: 'bash' } },
  ])
})

test('translate: agent.error is the one durable failure message for the user', () => {
  assert.deepEqual(translate(ev(1, 'agent.error', { errorMessage: 'sandbox exec timeout after 300s' })), [{ __error: 'sandbox exec timeout after 300s' }])
})

test('translate: plumbing events ride through as debug frames, never as content', () => {
  // agent.item is an ordering barrier / provider capture — internal, never user-visible.
  assert.deepEqual(translate(ev(1, 'agent.item', { kind: 'assistant_segment', phase: 'start', segment: 1 })), [
    { __zooclaw: 'agent.item', payload: { kind: 'assistant_segment', phase: 'start', segment: 1 } },
  ])
  assert.deepEqual(translate(ev(2, 'agent.lifecycle', { phase: 'start' })), [{ __zooclaw: 'agent.lifecycle', payload: { phase: 'start' } }])
  // unknown vocabulary degrades the same way instead of throwing (Developer Preview)
  assert.deepEqual(translate(ev(3, 'agent.newthing', { a: 1 })), [{ __zooclaw: 'agent.newthing', payload: { a: 1 } }])
})

test('driveTurn: a full turn streams in order and ends on run.finished', async () => {
  // The real event sequence a turn produces (SMOKE.md, staging 2026-08-05) — on the
  // unified lane, which opens with the session's own user.message echoed back and stamps
  // a resume token on every streamed event (a sample here; the newest one must win).
  const { client, cursors } = fakeClient([
    tok(ev(1, 'user.message', { content: 'find me options' }), 'tok-1'),
    ev(2, 'run.started', { trigger: 'user_message' }),
    ev(3, 'agent.lifecycle', { phase: 'start' }),
    ev(4, 'agent.item', { kind: 'assistant_segment', phase: 'start', segment: 1 }),
    tok(ev(5, 'agent.thinking', { text: 'let me look' }), 'tok-5'),
    assistant(6, 'Searching...'),
    ev(7, 'agent.tool', { phase: 'start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }),
    ev(8, 'agent.tool', { phase: 'end', toolCallId: 't1', toolName: 'bash', isError: false, resultPreview: 'ok' }),
    assistant(9, 'Found 3 options'),
    ev(10, 'agent.lifecycle', { phase: 'end' }),
    tok(ev(11, 'run.finished', { status: 'succeeded' }), 'tok-11'),
    assistant(12, 'never reached'),
  ])
  const { frames, sink } = arraySink()

  const end = await driveTurn(client, 'agt-1', 's-1', sink)
  assert.deepEqual(end, { terminal: true, status: 'succeeded', lastSeq: 11, cursor: 'tok-11' })
  assert.deepEqual(cursors, [undefined]) // fresh turn: no token in hand yet
  // the input echo rides through as a chat-invisible debug frame, like other plumbing
  assert.deepEqual(kindsOf(frames), ['user.message', 'run.started', 'agent.lifecycle', 'agent.item', 'thinking', 'assistant', 'assistant', 'user', 'assistant', 'agent.lifecycle'])
  // the two real answers landed as chat content, in order
  assert.deepEqual(
    frames.filter((f) => f.type === 'assistant' && !JSON.stringify(f).includes('tool_use')),
    [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Searching...' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Found 3 options' }] } },
    ],
  )
})

test('driveTurn: run.finished carries the run outcome enum, not the session status', async () => {
  for (const [status, expected] of [
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['aborted', 'aborted'],
    [undefined, 'succeeded'], // a terminal event with no readable status defaults to succeeded
  ] as const) {
    const { client } = fakeClient([ev(1, 'run.finished', status === undefined ? {} : { status })])
    const { sink } = arraySink()
    assert.deepEqual(await driveTurn(client, 'agt-1', 's-1', sink), { terminal: true, status: expected, lastSeq: 1 })
  }
})

test('driveTurn: dedupes a re-delivered final text via the emittedText ref across two windows', async () => {
  const { client, cursors } = fakeClient(
    [tok(assistant(1, 'Answer A'), 'tok-1')],
    // window 2 re-carries the answer (whitespace drift — normText containment must match)
    [tok(assistant(2, 'Answer  A'), 'tok-2')],
  )
  const { frames, sink } = arraySink()
  const emitted = { value: '' } // persisted by the caller (DO state) across windows

  const w1 = await driveTurn(client, 'agt-1', 's-1', sink, { emittedText: emitted })
  assert.deepEqual(w1, { terminal: false, lastSeq: 1, cursor: 'tok-1' })
  const w2 = await driveTurn(client, 'agt-1', 's-1', sink, { cursor: w1.cursor, skipThrough: w1.lastSeq, emittedText: emitted })

  assert.deepEqual(cursors, [undefined, 'tok-1']) // window 2 resumed from the token
  assert.deepEqual(w2, { terminal: false, lastSeq: 2, cursor: 'tok-2' }) // resume state still advances past the dupe
  assert.equal(frames.length, 1) // the duplicate never re-rendered
})

test('driveTurn: a window that ends without run.finished is non-terminal + resume state', async () => {
  const { client } = fakeClient([assistant(1, 'still working')])
  const { sink } = arraySink()
  // The stream is session-scoped and never closes at turn end, so this is the ordinary
  // mid-turn window: the caller polls session status and resumes from the token — here
  // absent (the event carried none), so `cursor` stays off TurnEnd and the caller falls
  // back to skipThrough=lastSeq.
  assert.deepEqual(await driveTurn(client, 'agt-1', 's-1', sink), { terminal: false, lastSeq: 1 })
})

test('driveTurn: pre-token restore streams cursorless and skips through the stored seq', async () => {
  // A caller migrating from the numeric-cursor era has a seq but no token — tokens are
  // opaque and never minted from one. The stream then replays the log from the start:
  // everything at or below the stored seq was already handled, INCLUDING the previous
  // turn's run.finished, which must not terminate this turn.
  const { client, cursors } = fakeClient([
    tok(assistant(1, 'old answer'), 'tok-1'),
    tok(ev(2, 'run.finished', { status: 'succeeded' }), 'tok-2'),
    tok(assistant(3, 'new answer'), 'tok-3'),
  ])
  const { frames, sink } = arraySink()

  const end = await driveTurn(client, 'agt-1', 's-1', sink, { skipThrough: 2 })
  assert.deepEqual(cursors, [undefined]) // cursorless — no token was in hand
  assert.deepEqual(end, { terminal: false, lastSeq: 3, cursor: 'tok-3' })
  assert.deepEqual(frames, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'new answer' }] } }])
})

test('driveTurn: a skipped event still hands over its token — the migration handshake', async () => {
  // The recovery window may see ONLY replayed events. They render nothing, but the newest
  // token must still come back so the caller overwrites its stored number and resumes
  // opaquely from now on.
  const { client } = fakeClient([tok(assistant(1, 'already shown'), 'tok-1')])
  const { frames, sink } = arraySink()

  const end = await driveTurn(client, 'agt-1', 's-1', sink, { skipThrough: 1 })
  assert.deepEqual(end, { terminal: false, lastSeq: 1, cursor: 'tok-1' })
  assert.equal(frames.length, 0)
})

test('driveTurn: a mid-stream error returns the partial progress WITH the error, never throws', async () => {
  // The frames emitted before the error are already durable in the caller's store —
  // swallowing lastSeq here would make the retry window re-append them (duplicate
  // bubbles that survive refresh, since frames are the source of truth).
  const boom = new Error('SSE reset')
  const client = {
    async *streamEvents() {
      yield tok(assistant(1, 'partial answer'), 'tok-1')
      throw boom
    },
  } as unknown as ZooclawClient
  const { frames, sink } = arraySink()
  const emitted = { value: '' }

  const end = await driveTurn(client, 'agt-1', 's-1', sink, { emittedText: emitted })
  assert.equal(end.terminal, false)
  assert.equal(end.lastSeq, 1) // progress up to the error is reported
  assert.equal(end.cursor, 'tok-1') // the token earned before the error rides along too
  assert.equal(end.streamError, boom) // and the error rides along for the caller to classify
  assert.deepEqual(kindsOf(frames), ['assistant']) // the pre-error frame was emitted
  assert.notEqual(emitted.value, '') // the text ledger advanced too
})
