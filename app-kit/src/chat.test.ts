/**
 * Contract test for the derive core (streaming-experience-contract I0): a refresh
 * (frames in one batch) must rebuild the exact view the live tail (frames fed
 * incrementally) produced — never losing, reordering, or rewriting earlier bubbles.
 * Also locks the Zooclaw control-frame split: `__zooclaw_session` / `__zooclaw`
 * derive NO chat bubble but stay visible to the DebugPanel's frame labeling.
 * Pure functions only; no quota burned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveChat, type ChatBubble } from './chat.ts'
import { frameLabel } from './components/DebugPanel.tsx'
import type { PromptContent } from './api.ts'

const frame = (seq: number, data: unknown) => ({ seq, data })
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const ask = (a: { actionId: number; messageId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; input?: unknown }) => ({ __ask: a })

/** Compare on observable shape, not on internal keys. */
const shape = (bs: ChatBubble[]) => bs.map((b) => ({ role: b.role, text: b.text, error: b.error }))

const FRAMES = [
  frame(1, { __zooclaw_session: 'sess_123' }),
  frame(2, assistant('Hello')),
  frame(3, assistant('Hello')), // duplicate of seq 2 → collapsed
  frame(4, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'DOMAIN-ONLY' }] } }),
  frame(5, { __zooclaw: 'thinking', payload: { text: 'pondering…' } }),
  frame(6, assistant('World')),
  frame(7, { __error: 'boom' }),
]
const prompt = (frames: { seq: number; data: unknown }[]): PromptContent => ({ id: 'p1', prompt: 'hi', frames })

test('I0: incremental live tail and one-shot refresh derive the identical view', () => {
  const batch = deriveChat([prompt(FRAMES)])
  let live: ChatBubble[] = []
  for (let k = 1; k <= FRAMES.length; k++) live = deriveChat([prompt(FRAMES.slice(0, k))])
  assert.deepEqual(live, batch)
})

test('I0: live derivation is prefix-stable (earlier bubbles never change as frames arrive)', () => {
  for (let k = 1; k < FRAMES.length; k++) {
    const short = shape(deriveChat([prompt(FRAMES.slice(0, k))]))
    const long = shape(deriveChat([prompt(FRAMES.slice(0, k + 1))]))
    assert.deepEqual(short, long.slice(0, short.length), `prefix broke between k=${k} and k=${k + 1}`)
  }
})

test('surfaces user / assistant / error; ignores control frames and domain tool_results; dedups', () => {
  assert.deepEqual(shape(deriveChat([prompt(FRAMES)])), [
    { role: 'user', text: 'hi', error: undefined },
    { role: 'assistant', text: 'Hello', error: undefined },
    { role: 'assistant', text: 'World', error: undefined },
    { role: 'assistant', text: 'boom', error: true },
  ])
})

test('the __zooclaw_session marker derives NO bubble (there is no public session URL)', () => {
  const bubbles = deriveChat([prompt([frame(1, { __zooclaw_session: 'sess_abc' })])])
  assert.deepEqual(shape(bubbles), [{ role: 'user', text: 'hi', error: undefined }])
})

test('__zooclaw passthroughs are chat-invisible but labeled for the debug panel', () => {
  const passthrough = { __zooclaw: 'agent.custom_event', payload: { anything: true } }
  const bubbles = deriveChat([prompt([frame(1, passthrough)])])
  assert.deepEqual(shape(bubbles), [{ role: 'user', text: 'hi', error: undefined }])
  // The DebugPanel's frame vocabulary still surfaces both control frames.
  assert.equal(frameLabel(passthrough), 'agent.custom_event')
  assert.equal(frameLabel({ __zooclaw: 'thinking', payload: { text: 'hm' } }), 'thinking')
  assert.equal(frameLabel({ __zooclaw_session: 'sess_abc' }), 'zooclaw_session')
})

test('non-object, empty-text, and unknown frames are skipped', () => {
  const bubbles = deriveChat([
    prompt([
      frame(1, null),
      frame(2, 'just a string'),
      frame(3, assistant('   ')), // whitespace-only → not a bubble
      frame(4, { type: 'system', message: { content: [{ type: 'text', text: 'noise' }] } }),
    ]),
  ])
  assert.deepEqual(shape(bubbles), [{ role: 'user', text: 'hi', error: undefined }])
})

test('empty transcript → empty chat', () => {
  assert.deepEqual(deriveChat([]), [])
})

test('ask_user_question → a question card; a later reply flips it answered (inert)', () => {
  const ASK = { actionId: 7, messageId: 'am', question: 'pick?', options: [{ label: 'A' }, { label: 'B' }] }
  // pending: no assistant text yet → card with answered:false (the user bubble is at index 0)
  const pending = deriveChat([prompt([frame(1, ask(ASK))])])
  assert.deepEqual(pending[1]?.ask, { ...ASK, answered: false })
  // answered: a reply after the ask flips the card inert, and the reply renders below it
  const done = deriveChat([prompt([frame(1, ask(ASK)), frame(2, assistant('You picked A'))])])
  assert.equal(done[1]?.ask?.answered, true)
  assert.equal(done[2]?.text, 'You picked A')
})

test('ask with a form input + multiSelect threads both into the Ask bubble (option-only ask stays minimal)', () => {
  const ASK = { actionId: 9, messageId: 'am2', question: 'fill?', options: [], multiSelect: true, input: { type: 'form', fields: [{ name: 'note' }] } }
  const bubbles = deriveChat([prompt([frame(1, ask(ASK))])])
  assert.deepEqual(bubbles[1]?.ask, { ...ASK, answered: false })
})
