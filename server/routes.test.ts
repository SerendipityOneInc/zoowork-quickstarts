/**
 * HTTP-layer tests over the in-memory store with a fake turn runner — no DO, no the ZooClaw API,
 * no quota. Proves tenant scoping (404 on cross-user), the create/follow-up turn wiring,
 * the attachments-disabled 501 gate, the /content self-heal hook (R3), and that GET /config
 * cannot leak a deployment secret. The SSE /stream is covered by tail.test.ts.
 *
 * Attachment display tests seed the store directly (saveAttachment) rather than going
 * through POST /files — that route 501s while ATTACHMENTS_ENABLED is off, but the display
 * channel (serve route + /content metadata) must keep working for a vertical that flips
 * uploads back on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { app, type RouteVars } from './routes.ts'
import { createMemStore } from './store-mem.ts'
import { describeRuntime, KIT_ENV_VARS, type Env } from '../worker/env.ts'

type Store = ReturnType<typeof createMemStore>

function makeApp(
  over: {
    userEmail?: string
    store?: Store
    recoverPrompt?: RouteVars['recoverPrompt']
    runTurnResult?: boolean
    runtimeConfig?: RouteVars['runtimeConfig']
  } = {},
) {
  const store = over.store ?? createMemStore()
  const runTurnCalls: Array<[string, string, string, string]> = []
  const runTurnOpts: Array<Parameters<RouteVars['runTurn']>[4]> = []
  const cancelCalls: string[] = []
  const uploadCalls: Array<{ name: string; type: string }> = []
  const answerCalls: Array<[string, Parameters<RouteVars['answerQuestion']>[1]]> = []
  const vars: RouteVars = {
    userEmail: over.userEmail ?? 'u@x.com',
    store,
    // Built the same way the Worker builds it, from an Env with nothing set.
    runtimeConfig: over.runtimeConfig ?? describeRuntime({} as Env),
    runTurn: async (taskId, projectId, promptId, prompt, opts) => {
      runTurnCalls.push([taskId, projectId, promptId, prompt])
      runTurnOpts.push(opts)
      return over.runTurnResult ?? true
    },
    cancelTurn: async (id) => {
      cancelCalls.push(id)
      return true
    },
    recoverPrompt: over.recoverPrompt ?? (async () => false),
    uploadFile: async (f) => {
      uploadCalls.push({ name: f.name, type: f.type })
      return { id: `id-${f.name}`, filename: f.name }
    },
    answerQuestion: async (taskId, body) => {
      answerCalls.push([taskId, body])
    },
  }
  const root = new Hono<{ Variables: RouteVars }>()
  root.use('*', async (c, next) => {
    c.set('userEmail', vars.userEmail)
    c.set('store', vars.store)
    c.set('runtimeConfig', vars.runtimeConfig)
    c.set('runTurn', vars.runTurn)
    c.set('cancelTurn', vars.cancelTurn)
    c.set('recoverPrompt', vars.recoverPrompt)
    c.set('uploadFile', vars.uploadFile)
    c.set('answerQuestion', vars.answerQuestion)
    await next()
  })
  root.route('/', app)
  return { root, store, runTurnCalls, runTurnOpts, cancelCalls, uploadCalls, answerCalls }
}

const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /files → 501 while attachments ship disabled, without calling uploadFile', async () => {
  const { root, uploadCalls } = makeApp()
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }))
  const res = await root.request('/files', { method: 'POST', body: fd })
  assert.equal(res.status, 501)
  assert.deepEqual(await res.json(), { error: 'attachments disabled: Zooclaw Files is not production-wired' })
  assert.deepEqual(uploadCalls, []) // gated before any staging upload
})

test('GET /files/:id serves the stored rendition (image/webp) and 404s cross-user', async () => {
  const { root, store } = makeApp()
  await store.saveAttachment('id-p.png', 'u@x.com', 'p.png', 'image/png',
    new Uint8Array([9, 9, 9]).buffer, new Uint8Array([7, 7]).buffer)

  const ok = await root.request('/files/id-p.png?size=thumb')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/webp')
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), new Uint8Array([9, 9, 9]))

  const large = await root.request('/files/id-p.png?size=large')
  assert.deepEqual(new Uint8Array(await large.arrayBuffer()), new Uint8Array([7, 7]))

  // another user, same shared store → denied (the per-user gate)
  const other = makeApp({ store, userEmail: 'other@x.com' })
  assert.equal((await other.root.request('/files/id-p.png?size=thumb')).status, 404)
})

test('GET /content surfaces a prompt’s attachments (metadata only)', async () => {
  const { root, store } = makeApp()
  await store.saveAttachment('id-a.png', 'u@x.com', 'a.png', 'image/png', new Uint8Array([2]).buffer, new Uint8Array([3]).buffer)
  const created = (await (
    await root.request('/tasks', postJson({ prompt: 'what is this', files: [{ id: 'id-a.png', filename: 'a.png' }] }))
  ).json()) as { taskId: string }
  const body = (await (await root.request(`/tasks/${created.taskId}/content`)).json()) as {
    prompts: Array<{ attachments?: Array<Record<string, string>> }>
  }
  // /content returns metadata only; the client derives the rendition URLs (api.toAttachment).
  assert.deepEqual(body.prompts[0]?.attachments, [
    { fileId: 'id-a.png', filename: 'a.png', contentType: 'image/png' },
  ])
})

test('POST /tasks with files links them for display but does NOT forward them to the turn', async () => {
  const { root, store, runTurnOpts } = makeApp()
  const files = [{ id: 'id-x', filename: 'x.png' }]
  await store.saveAttachment('id-x', 'u@x.com', 'x.png', 'image/png', null, null)
  const res = await root.request('/tasks', postJson({ prompt: 'hi', files }))
  assert.equal(res.status, 200)
  const { promptId } = (await res.json()) as { promptId: string }
  // Linked for the bubble…
  assert.deepEqual((await store.listPromptAttachments(promptId)).map((a) => a.fileId), ['id-x'])
  // …but the runner sees no files: opts carries agentConfig only.
  assert.equal(Object.prototype.hasOwnProperty.call(runTurnOpts[0] ?? {}, 'files'), false)
})

test('POST /tasks/:id/prompts also passes no files to the turn', async () => {
  const { root, store, runTurnOpts } = makeApp()
  const created = (await (await root.request('/tasks', postJson({ prompt: 'first' }))).json()) as { taskId: string; promptId: string }
  await store.finishPrompt(created.promptId, 'completed') // prior turn done — the busy guard admits the follow-up
  const files = [{ id: 'id-y', filename: 'y.pdf' }]
  const res = await root.request(`/tasks/${created.taskId}/prompts`, postJson({ prompt: 'again', files }))
  assert.equal(res.status, 200)
  assert.equal(Object.prototype.hasOwnProperty.call(runTurnOpts[runTurnOpts.length - 1] ?? {}, 'files'), false)
})

test('POST /tasks/:id/prompts refuses a follow-up while the latest prompt is still running (409)', async () => {
  // The frontend busy flag is per-tab state — the server must refuse a concurrent turn
  // itself, or the loser prompt would sit 'running' forever with no finalize path.
  const { root, store, runTurnCalls } = makeApp()
  const created = (await (await root.request('/tasks', postJson({ prompt: 'first' }))).json()) as { taskId: string }
  const before = runTurnCalls.length
  const res = await root.request(`/tasks/${created.taskId}/prompts`, postJson({ prompt: 'too soon' }))
  assert.equal(res.status, 409)
  assert.equal(runTurnCalls.length, before) // never reached the runner
  // and no orphan prompt row was created for the refused turn
  assert.equal((await store.listPrompts(created.taskId)).length, 1)
})

test('a runner-refused turn marks the loser prompt failed instead of leaving it running', async () => {
  // Two concurrent submits can both pass the busy-guard read; the DO is the tiebreaker.
  const { root, store } = makeApp({ runTurnResult: false })
  const res = await root.request('/tasks', postJson({ prompt: 'first' }))
  assert.equal(res.status, 409) // the refusal reaches the caller
  const [task] = await store.listTasksByUser('u@x.com')
  const prompts = await store.listPrompts(task!.id)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]!.status, 'failed') // not orphaned in 'running'
})

test('POST /tasks with files augments the WIRE prompt with staged paths but stores only the user text', async () => {
  const { root, store, runTurnCalls } = makeApp()
  const files = [{ id: 'id-z', filename: 'photo.png' }]
  const res = await root.request('/tasks', postJson({ prompt: 'what is this', files }))
  assert.equal(res.status, 200)
  const { promptId } = (await res.json()) as { promptId: string }
  // The prompt handed to runTurn (sent to the agent) keeps the user text AND names the staged path.
  const wire = runTurnCalls[runTurnCalls.length - 1]![3]
  assert.match(wire, /what is this/)
  assert.match(wire, /photo\.png/)
  assert.notEqual(wire, 'what is this') // the attachment directive was appended
  // But the stored prompt (what the UI renders) is the user's text only — no injected directive.
  const stored = await store.getPrompt(promptId)
  assert.equal(stored?.prompt, 'what is this')
})

test('POST /tasks WITHOUT files sends the prompt verbatim (no directive)', async () => {
  const { root, runTurnCalls } = makeApp()
  const res = await root.request('/tasks', postJson({ prompt: 'just text' }))
  assert.equal(res.status, 200)
  assert.equal(runTurnCalls[runTurnCalls.length - 1]![3], 'just text')
})

test('GET /me returns the authed email', async () => {
  const { root } = makeApp()
  assert.deepEqual(await (await root.request('/me')).json(), { email: 'u@x.com' })
})

/** Every declared variable, filled with a value nothing else in the response could contain.
 *  Driven off KIT_ENV_VARS, which worker/env.ts builds from a `Record<ConfigurableEnvKey, …>`
 *  — so this sentinel set is exhaustive over Env by TYPE, not by convention: a new variable
 *  that skipped the declaration would fail `tsc` before it could reach this test uncovered. */
function sentinelEnv(): { env: Env; sentinels: Map<string, string> } {
  const sentinels = new Map(KIT_ENV_VARS.map((v) => [v.name, `zct_LEAK_SENTINEL_${v.name}_9f3a`]))
  // ZOOCLAW_API_URL is the one variable whose value is deliberately public (it IS the
  // resolved base URL), so its sentinel is shaped like the URL it stands in for.
  sentinels.set('ZOOCLAW_API_URL', 'https://leak-sentinel.example/service/v1')
  return { env: Object.fromEntries(sentinels) as unknown as Env, sentinels }
}

test('GET /config reports every declared variable as presence ONLY (no value-bearing field)', async () => {
  const { env } = sentinelEnv()
  const { root } = makeApp({ runtimeConfig: describeRuntime(env) })
  const res = await root.request('/config')
  assert.equal(res.status, 200)
  const body = (await res.json()) as RouteVars['runtimeConfig']

  // The `runtime` object is locked to an exact key set, for the same reason each env row is.
  // A whole-string sentinel search cannot catch a value that arrives MASKED, TRUNCATED,
  // last-4 or base64'd — `runtime.apiKeyPreview: 'zct_LEAK_SEN…'` would sail past the leak
  // test below. So widening `runtime` has to be a deliberate edit to this list, and
  // `apiBaseUrl` (already a raw Env value) stays the single reviewed exception.
  assert.deepEqual(
    Object.keys(body.runtime).sort(),
    ['apiBaseUrl', 'apiBaseUrlFrom', 'attachments', 'embedGate', 'identity', 'provisioning', 'transport'],
    'runtime object shape',
  )

  assert.equal(body.env.length, KIT_ENV_VARS.length)
  for (const row of body.env) {
    // Shape, not one hard-coded key: a row may carry ONLY these four fields. Adding a
    // `value` (or anything else sourced from Env) fails here.
    assert.deepEqual(Object.keys(row).sort(), ['configured', 'effect', 'name', 'secret'], `${row.name} row shape`)
    assert.equal(typeof row.configured, 'boolean')
    assert.equal(row.configured, true) // every sentinel was set, so presence is really derived from Env
  }
})

test('GET /config never echoes a variable VALUE — only the deliberately public base URL', async () => {
  // The whole point: a leaked zct_ token is a tenant-wide compromise, so this must fail
  // loudly the moment anyone widens the response to carry a value.
  const { env, sentinels } = sentinelEnv()
  const { root } = makeApp({ runtimeConfig: describeRuntime(env) })
  const body = (await (await root.request('/config')).json()) as RouteVars['runtimeConfig']

  // The single sanctioned exception, named explicitly.
  assert.equal(body.runtime.apiBaseUrl, sentinels.get('ZOOCLAW_API_URL'))
  assert.equal(body.runtime.apiBaseUrlFrom, 'ZOOCLAW_API_URL')

  // Blank that one field out; NO other variable's value may appear anywhere in the rest of
  // the response — not in `env`, not in a mode flag, not in a nested field added later.
  const rest = JSON.stringify({ ...body, runtime: { ...body.runtime, apiBaseUrl: '' } })
  for (const [name, sentinel] of sentinels) {
    if (name === 'ZOOCLAW_API_URL') continue
    assert.equal(rest.includes(sentinel), false, `${name} value leaked into GET /config`)
  }
})

test('GET /config derives the deployment mode flags from Env', async () => {
  const fixed = describeRuntime({ ZOOCLAW_API_KEY: 'zct_x', ZOOCLAW_AGENT_ID: 'agt_x', DEV_EMAIL: 'you@example.com' } as Env)
  assert.deepEqual(
    { t: fixed.runtime.transport, p: fixed.runtime.provisioning, i: fixed.runtime.identity, e: fixed.runtime.embedGate },
    { t: 'gateway', p: 'fixed-agent', i: 'dev-email', e: false },
  )
  // No key → nothing can reach the API at all; no ZOOCLAW_AGENT_ID → per-user provisioning.
  const bare = describeRuntime({} as Env)
  assert.deepEqual(
    { t: bare.runtime.transport, p: bare.runtime.provisioning, i: bare.runtime.identity, from: bare.runtime.apiBaseUrlFrom },
    { t: 'unconfigured', p: 'per-user', i: 'unconfigured', from: 'sdk-default' },
  )
  assert.equal(bare.env.every((e) => e.configured === false), true)
})

test('POST /tasks creates the task + first prompt and fires the turn', async () => {
  const { root, store, runTurnCalls } = makeApp()
  const res = await root.request('/tasks', postJson({ prompt: 'find flights' }))
  assert.equal(res.status, 200)
  const { taskId, promptId } = (await res.json()) as { taskId: string; promptId: string }
  assert.equal((await store.getTask(taskId))?.user_email, 'u@x.com')
  assert.equal((await store.getPrompt(promptId))?.prompt, 'find flights')
  assert.deepEqual(runTurnCalls, [[taskId, 'default', promptId, 'find flights']])
})

test('POST /tasks rejects an empty prompt', async () => {
  const { root } = makeApp()
  assert.equal((await root.request('/tasks', postJson({ prompt: '   ' }))).status, 400)
})

test('POST /tasks forwards systemPrompt + tools to runTurn as agentConfig', async () => {
  const { root, runTurnOpts } = makeApp()
  await root.request('/tasks', postJson({ prompt: 'hi', systemPrompt: 'be terse', tools: { web_search: false } }))
  assert.deepEqual(runTurnOpts[0]?.agentConfig, { systemPrompt: 'be terse', tools: { web_search: false } })
})

test('POST /tasks folds skillId into agentConfig when sent', async () => {
  const { root, runTurnOpts } = makeApp()
  const skillId = 'skl_0123456789abcdef'
  await root.request('/tasks', postJson({ prompt: 'hi', systemPrompt: 'x', tools: {}, skillId }))
  assert.deepEqual(runTurnOpts[0]?.agentConfig, { systemPrompt: 'x', tools: {}, skillId })
})

test('POST /tasks with only skillId still builds agentConfig', async () => {
  const { root, runTurnOpts } = makeApp()
  await root.request('/tasks', postJson({ prompt: 'hi', skillId: 'skl_abc' }))
  assert.deepEqual(runTurnOpts[0]?.agentConfig, { systemPrompt: '', tools: {}, skillId: 'skl_abc' })
})

test('POST /tasks with no config leaves agentConfig undefined (runner uses its default)', async () => {
  const { root, runTurnOpts } = makeApp()
  await root.request('/tasks', postJson({ prompt: 'hi' }))
  assert.equal(runTurnOpts[0]?.agentConfig, undefined)
})

test('GET /tasks lists only the caller’s sessions', async () => {
  const store = createMemStore()
  await store.createTask('mine', 'default', 'u@x.com')
  await store.createTask('theirs', 'default', 'other@x.com')
  const { root } = makeApp({ store })
  const { tasks } = (await (await root.request('/tasks')).json()) as { tasks: Array<{ id: string }> }
  assert.deepEqual(tasks.map((t) => t.id), ['mine'])
})

test('cross-user access is rejected (404)', async () => {
  const store = createMemStore()
  await store.createTask('t1', 'default', 'other@x.com')
  const { root } = makeApp({ store, userEmail: 'u@x.com' })
  assert.equal((await root.request('/tasks/t1/prompts', postJson({ prompt: 'hi' }))).status, 404)
})

test('GET /content self-heals a terminal turn with no rendered answer (R3)', async () => {
  const store = createMemStore()
  await store.createTask('t1', 'default', 'u@x.com')
  await store.createPrompt('p1', 't1', 'q')
  await store.finishPrompt('p1', 'completed') // terminal, zero frames → needs heal
  let recovered = 0
  const recoverPrompt: RouteVars['recoverPrompt'] = async (_taskId, pid) => {
    recovered++
    await store.appendFrame(pid, 1, { type: 'assistant', message: { content: [{ type: 'text', text: 'healed answer' }] } })
    return true
  }
  const { root } = makeApp({ store, recoverPrompt })
  const body = (await (await root.request('/tasks/t1/content')).json()) as {
    prompts: Array<{ frames: Array<{ data: { message: { content: [{ text: string }] } } }> }>
  }
  assert.equal(recovered, 1)
  assert.equal(body.prompts[0]?.frames[0]?.data.message.content[0].text, 'healed answer')
})

test('POST /cancel routes to cancelTurn for an owned prompt', async () => {
  const store = createMemStore()
  await store.createTask('t1', 'default', 'u@x.com')
  await store.createPrompt('p1', 't1', 'q')
  const { root, cancelCalls } = makeApp({ store })
  assert.deepEqual(await (await root.request('/prompts/p1/cancel', { method: 'POST' })).json(), { ok: true })
  assert.deepEqual(cancelCalls, ['p1'])
})

test('POST /tasks/:id/answer forwards the ids to answerQuestion and returns ok', async () => {
  const store = createMemStore()
  await store.createTask('t1', 'default', 'u@x.com')
  const { root, answerCalls } = makeApp({ store })
  const body = { messageId: 'am_1', actionId: 42, answer: { selectedOptions: [0], customResponse: 'blue' } }
  assert.deepEqual(await (await root.request('/tasks/t1/answer', postJson(body))).json(), { ok: true })
  assert.deepEqual(answerCalls, [['t1', body]])
})

test('POST /tasks/:id/answer 404s for a cross-user / unknown task (without calling answerQuestion)', async () => {
  const store = createMemStore()
  await store.createTask('t1', 'default', 'other@x.com')
  const { root, answerCalls } = makeApp({ store, userEmail: 'u@x.com' })
  const res = await root.request('/tasks/t1/answer', postJson({ messageId: 'am_1', actionId: 1, answer: { selectedOptions: [0] } }))
  assert.equal(res.status, 404)
  assert.equal(answerCalls.length, 0)
})

test('POST /tasks/:id/answer rejects a malformed body (400) before calling answerQuestion', async () => {
  const store = createMemStore()
  await store.createTask('t1', 'default', 'u@x.com')
  const { root, answerCalls } = makeApp({ store })
  // actionId must be a number; answer must be present.
  const res = await root.request('/tasks/t1/answer', postJson({ messageId: 'am_1', actionId: 'nope' }))
  assert.equal(res.status, 400)
  // ids valid but no answer → also rejected
  const res2 = await root.request('/tasks/t1/answer', postJson({ messageId: 'am_1', actionId: 1 }))
  assert.equal(res2.status, 400)
  assert.equal(answerCalls.length, 0)
})
