/**
 * Store-contract tests, exercised against the in-memory driver. These pin the behaviour
 * the D1 driver must also satisfy — most importantly framesSince's resumable read
 * (streaming-experience-contract I3: only seq > cursor, in order, no repeats/gaps).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemStore } from './store-mem.ts'

test('framesSince: returns only seq > cursor, ordered (I3 resumable read)', async () => {
  const s = createMemStore()
  await s.appendFrame('p', 1, { a: 1 })
  await s.appendFrame('p', 2, { a: 2 })
  await s.appendFrame('p', 3, { a: 3 })
  assert.deepEqual((await s.framesSince('p', 0)).map((f) => f.seq), [1, 2, 3])
  assert.deepEqual((await s.framesSince('p', 1)).map((f) => f.seq), [2, 3])
  assert.deepEqual((await s.framesSince('p', 3)).map((f) => f.seq), [])
  assert.deepEqual(await s.framesSince('unknown', 0), [])
})

test('framesSince: orders by seq even when appended out of order', async () => {
  const s = createMemStore()
  await s.appendFrame('p', 3, {})
  await s.appendFrame('p', 1, {})
  await s.appendFrame('p', 2, {})
  assert.deepEqual((await s.framesSince('p', 0)).map((f) => f.seq), [1, 2, 3])
})

test('appendFrame stores a structural clone, not a live reference', async () => {
  const s = createMemStore()
  const data = { a: 1 }
  await s.appendFrame('p', 1, data)
  data.a = 999
  assert.deepEqual((await s.framesSince('p', 0)).map((f) => f.data), [{ a: 1 }])
})

test('task lifecycle: create defaults to running, status/session writes round-trip', async () => {
  const s = createMemStore()
  await s.createTask('t1', 'proj', 'a@x.com')
  const fresh = await s.getTask('t1')
  assert.equal(fresh?.status, 'running')
  assert.equal(fresh?.session_id, null) // no Zooclaw session until the first turn creates it
  await s.setTaskStatus('t1', 'completed')
  await s.setTaskSessionId('t1', 'sess_1')
  const t = await s.getTask('t1')
  assert.equal(t?.status, 'completed')
  assert.equal(t?.session_id, 'sess_1')
  assert.equal(await s.getTask('missing'), undefined)
})

test('listTasksByUser: newest first, title from first prompt, scoped by user', async () => {
  const s = createMemStore()
  await s.createTask('t1', 'proj', 'a@x.com')
  await s.createPrompt('p1', 't1', 'first question that is the title')
  await s.createTask('t2', 'proj', 'a@x.com')
  await s.createTask('t3', 'proj', 'other@x.com')
  const list = await s.listTasksByUser('a@x.com')
  assert.deepEqual(list.map((t) => t.id), ['t2', 't1']) // created_at DESC
  assert.equal(list.find((t) => t.id === 't1')?.title, 'first question that is the title')
  assert.equal(list.find((t) => t.id === 't2')?.title, '') // no prompts yet
})

test('prompt lifecycle: listPrompts ASC, finishPrompt only flips a running prompt', async () => {
  const s = createMemStore()
  await s.createTask('t1', 'proj', 'a@x.com')
  await s.createPrompt('p1', 't1', 'one')
  await s.createPrompt('p2', 't1', 'two')
  assert.deepEqual((await s.listPrompts('t1')).map((p) => p.id), ['p1', 'p2'])

  await s.finishPrompt('p1', 'completed')
  const p1 = await s.getPrompt('p1')
  assert.equal(p1?.status, 'completed')
  assert.ok(p1?.completed_at)

  // already terminal → finishPrompt is a no-op (mirrors the running-only SQL guard)
  await s.finishPrompt('p1', 'failed')
  assert.equal((await s.getPrompt('p1'))?.status, 'completed')
})

test('saveZooclawAgent is INSERT OR IGNORE; setZooclawAgentConfig updates the fingerprint', async () => {
  const s = createMemStore()
  await s.saveZooclawAgent('a@x.com', 'agt-1', null)
  await s.saveZooclawAgent('a@x.com', 'agt-2', 'h2') // ignored (first writer wins)
  assert.deepEqual(await s.getZooclawAgent('a@x.com'), { agentId: 'agt-1', configHash: null })
  await s.setZooclawAgentConfig('a@x.com', 'h9')
  assert.deepEqual(await s.getZooclawAgent('a@x.com'), { agentId: 'agt-1', configHash: 'h9' })
  assert.equal(await s.getZooclawAgent('nobody@x.com'), undefined)
})

test('deleteZooclawAgent forgets the row so a later save is no longer ignored', async () => {
  const s = createMemStore()
  await s.saveZooclawAgent('a@x.com', 'agt-stale', 'h1')
  await s.deleteZooclawAgent('a@x.com')
  assert.equal(await s.getZooclawAgent('a@x.com'), undefined)
  // The whole point of delete: email is the PK, so re-provisioning MUST insert fresh.
  await s.saveZooclawAgent('a@x.com', 'agt-fresh', null)
  assert.deepEqual(await s.getZooclawAgent('a@x.com'), { agentId: 'agt-fresh', configHash: null })
})
