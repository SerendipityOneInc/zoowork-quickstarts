/**
 * api client tests with an injected fake fetch — zero quota, no server. Covers URL
 * shaping, the { tasks } unwrap, the JSON body, loadContent's 404→null, and error
 * throwing. (streamPrompt uses EventSource — browser-only — and is verified by a real run.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMe, listSessions, createTask, followup, loadContent } from './api.ts'

let lastUrl = ''
let lastInit: RequestInit | undefined
let responder: () => Response = () => new Response('{}')
const g = globalThis as { fetch: typeof fetch }
g.fetch = (async (url: string | URL, init?: RequestInit) => {
  lastUrl = String(url)
  lastInit = init
  return responder()
}) as typeof fetch

test('getMe → GET /api/app/me', async () => {
  responder = () => new Response(JSON.stringify({ email: 'u@x.com' }))
  assert.deepEqual(await getMe(), { email: 'u@x.com' })
  assert.equal(lastUrl, '/api/app/me')
})

test('listSessions unwraps { tasks }', async () => {
  responder = () => new Response(JSON.stringify({ tasks: [{ id: 't1', status: 'completed', created_at: '2026-06-15', title: 'hi' }] }))
  const s = await listSessions()
  assert.equal(lastUrl, '/api/app/tasks')
  assert.deepEqual(s.map((x) => x.id), ['t1'])
})

test('createTask POSTs the prompt as JSON', async () => {
  responder = () => new Response(JSON.stringify({ taskId: 't1', promptId: 'p1' }))
  assert.deepEqual(await createTask('hello'), { taskId: 't1', promptId: 'p1' })
  assert.equal(lastUrl, '/api/app/tasks')
  assert.equal(lastInit?.method, 'POST')
  assert.deepEqual(JSON.parse(lastInit?.body as string), { prompt: 'hello' })
})

test('createTask with config POSTs systemPrompt + tools', async () => {
  responder = () => new Response(JSON.stringify({ taskId: 't1', promptId: 'p1' }))
  await createTask('hi', { systemPrompt: 'be terse', tools: { web_search: false } })
  assert.deepEqual(JSON.parse(lastInit?.body as string), {
    prompt: 'hi',
    systemPrompt: 'be terse',
    tools: { web_search: false },
  })
})

test('createTask sends a trimmed skillId only when set', async () => {
  responder = () => new Response(JSON.stringify({ taskId: 't1', promptId: 'p1' }))
  await createTask('hi', { systemPrompt: '', tools: {}, skillId: '  skl_0123456789abcdef  ' })
  assert.deepEqual(JSON.parse(lastInit?.body as string), {
    prompt: 'hi',
    systemPrompt: '',
    tools: {},
    skillId: 'skl_0123456789abcdef',
  })
  // A blank / whitespace-only skillId is omitted from the wire (= no skill installed).
  await createTask('hi', { systemPrompt: '', tools: {}, skillId: '   ' })
  assert.deepEqual(JSON.parse(lastInit?.body as string), { prompt: 'hi', systemPrompt: '', tools: {} })
})

test('followup POSTs to the task prompts endpoint', async () => {
  responder = () => new Response(JSON.stringify({ promptId: 'p2' }))
  await followup('t1', 'again')
  assert.equal(lastUrl, '/api/app/tasks/t1/prompts')
  assert.deepEqual(JSON.parse(lastInit?.body as string), { prompt: 'again' })
})

test('loadContent returns null on 404, parsed content on 200', async () => {
  responder = () => new Response('nope', { status: 404 })
  assert.equal(await loadContent('t1'), null)
  responder = () => new Response(JSON.stringify({ task: { id: 't1', status: 'running' }, prompts: [] }))
  assert.equal((await loadContent('t1'))?.task.id, 't1')
})

test('a non-ok response throws', async () => {
  responder = () => new Response('boom', { status: 500 })
  await assert.rejects(() => getMe())
})
