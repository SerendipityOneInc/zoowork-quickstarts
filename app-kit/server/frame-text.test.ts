/**
 * Truth tables for the R3 self-heal detectors (streaming-experience-contract R3): a turn
 * can finalize with its answer never rendered, so a refresh that reads only the store
 * must detect it (framesHaveAssistantText) — and stop re-detecting once a couple of heal
 * attempts already failed (healAttemptCount caps the upstream transcript reads the
 * shared service token would otherwise amplify). Pure functions; no quota burned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantFrameText, framesHaveAssistantText, healAttemptCount, isHealAttemptFrame } from './frame-text.ts'
import type { Frame } from './store.ts'

const assistant = (text: string | string[]) => ({
  type: 'assistant',
  message: { content: (Array.isArray(text) ? text : [text]).map((t) => ({ type: 'text', text: t })) },
})

test('assistantFrameText: joins text parts, else null', () => {
  assert.equal(assistantFrameText(assistant(['A', 'B'])), 'AB')
  assert.equal(assistantFrameText(assistant('hi')), 'hi')
  assert.equal(assistantFrameText(assistant('   ')), null) // whitespace-only
  assert.equal(assistantFrameText({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } }), null)
  assert.equal(assistantFrameText({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }), null)
  assert.equal(assistantFrameText('nope'), null)
  assert.equal(assistantFrameText(null), null)
})

test('framesHaveAssistantText', () => {
  assert.equal(framesHaveAssistantText([{ seq: 1, data: assistant('hi') }]), true)
  assert.equal(framesHaveAssistantText([{ seq: 1, data: { __zooclaw: 'thinking', payload: { text: 'hm' } } }]), false)
  assert.equal(framesHaveAssistantText([]), false)
})

test('heal-attempt markers: recognized and counted, invisible to text detection', () => {
  const marker = { __heal_attempted: true }
  assert.equal(isHealAttemptFrame(marker), true)
  assert.equal(isHealAttemptFrame({ __heal_attempted: 'yes' }), false) // strictly boolean true
  assert.equal(isHealAttemptFrame(assistant('hi')), false)
  const frames: Frame[] = [
    { seq: 1, data: { __zooclaw_session: 'ses_x' } },
    { seq: 2, data: marker },
    { seq: 3, data: marker },
  ]
  assert.equal(healAttemptCount(frames), 2)
  assert.equal(framesHaveAssistantText(frames), false)
})
