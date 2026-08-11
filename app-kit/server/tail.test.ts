/**
 * I1 live-tail tests (streaming-experience-contract I1): live = tailing the store by seq,
 * never connecting to the agent. Driven over the in-memory store with an injected sleep so
 * it runs instantly; no quota.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tailFrames } from './tail.ts'
import { createMemStore } from './store-mem.ts'

test('streams new frames as SSE, then a done when the prompt finishes', async () => {
  const store = createMemStore()
  await store.createTask('t', 'p', 'u')
  await store.createPrompt('p1', 't', 'q')
  await store.appendFrame('p1', 1, { a: 1 })
  await store.appendFrame('p1', 2, { a: 2 })

  const writes: string[] = []
  let polls = 0
  // On the first poll, a late frame lands and the prompt completes — exercises the drain.
  const sleep = async (): Promise<void> => {
    polls++
    if (polls === 1) {
      await store.appendFrame('p1', 3, { a: 3 })
      await store.finishPrompt('p1', 'completed')
    }
  }
  await tailFrames(store, 'p1', 0, (l) => void writes.push(l), () => true, { sleep })

  assert.deepEqual(writes, [
    'id: 1\ndata: {"a":1}\n\n',
    'id: 2\ndata: {"a":2}\n\n',
    'id: 3\ndata: {"a":3}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ])
})

test('resumes from fromSeq, only sending later frames (I3-style cursor)', async () => {
  const store = createMemStore()
  await store.createPrompt('p1', 't', 'q')
  await store.appendFrame('p1', 1, { a: 1 })
  await store.appendFrame('p1', 2, { a: 2 })
  await store.finishPrompt('p1', 'completed')
  const writes: string[] = []
  await tailFrames(store, 'p1', 1, (l) => void writes.push(l), () => true, { sleep: async () => {} })
  assert.deepEqual(writes, ['id: 2\ndata: {"a":2}\n\n', 'event: done\ndata: {"status":"completed"}\n\n'])
})

test('stops immediately when the client has disconnected (isAlive false)', async () => {
  const store = createMemStore()
  await store.createPrompt('p1', 't', 'q')
  await store.appendFrame('p1', 1, { a: 1 })
  const writes: string[] = []
  await tailFrames(store, 'p1', 0, (l) => void writes.push(l), () => false)
  assert.deepEqual(writes, [])
})
