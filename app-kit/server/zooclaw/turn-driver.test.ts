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
 * ACROSS windows, and `run.finished` ends the turn with its own status enum.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate, driveTurn, type FrameData, type FrameSink } from './turn-driver.ts'
import type { SessionEvent, ZooclawClient } from '@zooclaw-agents/sdk'

const ev = (seq: number, eventType: string, payload: Record<string, unknown> = {}): SessionEvent => ({ seq, eventType, payload })

const assistant = (seq: number, text: string): SessionEvent => ev(seq, 'agent.assistant', { segment: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })

/** ZooclawClient double exposing ONLY streamEvents (all driveTurn touches). Each call
 *  serves the next window's events and records the resume cursor it was handed. */
function fakeClient(...windows: SessionEvent[][]): { client: ZooclawClient; afters: (number | undefined)[] } {
  const afters: (number | undefined)[] = []
  let w = 0
  const client = {
    async *streamEvents(_agentId: string, _sessionId: string, opts: { after?: number } = {}) {
      afters.push(opts.after)
      for (const e of windows[w] ?? []) yield e
      w++
    },
  } as unknown as ZooclawClient
  return { client, afters }
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
  // The real event sequence a turn produces (SMOKE.md, staging 2026-08-05).
  const { client, afters } = fakeClient([
    ev(1, 'run.started', { trigger: 'user_message' }),
    ev(2, 'agent.lifecycle', { phase: 'start' }),
    ev(3, 'agent.item', { kind: 'assistant_segment', phase: 'start', segment: 1 }),
    ev(4, 'agent.thinking', { text: 'let me look' }),
    assistant(5, 'Searching...'),
    ev(6, 'agent.tool', { phase: 'start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }),
    ev(7, 'agent.tool', { phase: 'end', toolCallId: 't1', toolName: 'bash', isError: false, resultPreview: 'ok' }),
    assistant(8, 'Found 3 options'),
    ev(9, 'agent.lifecycle', { phase: 'end' }),
    ev(10, 'run.finished', { status: 'succeeded' }),
    assistant(11, 'never reached'),
  ])
  const { frames, sink } = arraySink()

  const end = await driveTurn(client, 'agt-1', 's-1', sink)
  assert.deepEqual(end, { terminal: true, status: 'succeeded', lastSeq: 10 })
  assert.deepEqual(afters, [0])
  assert.deepEqual(kindsOf(frames), ['run.started', 'agent.lifecycle', 'agent.item', 'thinking', 'assistant', 'assistant', 'user', 'assistant', 'agent.lifecycle'])
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
  const { client, afters } = fakeClient(
    [assistant(1, 'Answer A')],
    // window 2 re-carries the answer (whitespace drift — normText containment must match)
    [assistant(2, 'Answer  A')],
  )
  const { frames, sink } = arraySink()
  const emitted = { value: '' } // persisted by the caller (DO state) across windows

  const w1 = await driveTurn(client, 'agt-1', 's-1', sink, { emittedText: emitted })
  assert.deepEqual(w1, { terminal: false, lastSeq: 1 })
  const w2 = await driveTurn(client, 'agt-1', 's-1', sink, { after: w1.lastSeq, emittedText: emitted })

  assert.deepEqual(afters, [0, 1]) // window 2 resumed from the cursor
  assert.deepEqual(w2, { terminal: false, lastSeq: 2 }) // seq still advances past the dupe
  assert.equal(frames.length, 1) // the duplicate never re-rendered
})

test('driveTurn: a window that ends without run.finished is non-terminal + a resume cursor', async () => {
  const { client } = fakeClient([assistant(1, 'still working')])
  const { sink } = arraySink()
  // The stream is session-scoped and never closes at turn end, so this is the ordinary
  // mid-turn window: the caller polls session status and resumes from lastSeq.
  assert.deepEqual(await driveTurn(client, 'agt-1', 's-1', sink), { terminal: false, lastSeq: 1 })
})

test('driveTurn: a mid-stream error returns the partial progress WITH the error, never throws', async () => {
  // The frames emitted before the error are already durable in the caller's store —
  // swallowing lastSeq here would make the retry window re-append them (duplicate
  // bubbles that survive refresh, since frames are the source of truth).
  const boom = new Error('SSE reset')
  const client = {
    async *streamEvents() {
      yield assistant(1, 'partial answer')
      throw boom
    },
  } as unknown as ZooclawClient
  const { frames, sink } = arraySink()
  const emitted = { value: '' }

  const end = await driveTurn(client, 'agt-1', 's-1', sink, { emittedText: emitted })
  assert.equal(end.terminal, false)
  assert.equal(end.lastSeq, 1) // progress up to the error is reported
  assert.equal(end.streamError, boom) // and the error rides along for the caller to classify
  assert.deepEqual(kindsOf(frames), ['assistant']) // the pre-error frame was emitted
  assert.notEqual(emitted.value, '') // the text ledger advanced too
})
