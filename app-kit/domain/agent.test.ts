import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolPolicy, defaultAgentConfig, TOOLS, attachmentPromptSuffix } from './agent.ts'

test('buildToolPolicy: all toggles on → {} (the full tool manifest)', () => {
  const allOn = Object.fromEntries(TOOLS.map((t) => [t.key, true]))
  assert.deepEqual(buildToolPolicy(allOn), {})
})

test('buildToolPolicy: an absent key falls back to the toggle default', () => {
  // defaults are all-on in the shipped registry → empty policy
  assert.deepEqual(buildToolPolicy({}), {})
})

test('buildToolPolicy: a toggled-off tool lands in deny by its OpenClaw toolName', () => {
  const registry = [
    { key: 'a', label: '', description: '', toolName: 'tool_a', defaultOn: true },
    { key: 'b', label: '', description: '', toolName: 'tool_b', defaultOn: true },
  ]
  assert.deepEqual(buildToolPolicy({ a: false }, registry), { deny: ['tool_a'] })
  assert.deepEqual(buildToolPolicy({ a: false, b: false }, registry), { deny: ['tool_a', 'tool_b'] })
})

test('a fresh config starts with an empty skillId (no skill installed)', () => {
  const cfg = defaultAgentConfig()
  assert.equal(cfg.skillId, '')
  // and every registered toggle is present at its default
  for (const t of TOOLS) assert.equal(cfg.tools[t.key], t.defaultOn)
})

test('attachmentPromptSuffix: empty for no files, workspace paths otherwise', () => {
  assert.equal(attachmentPromptSuffix([]), '')
  const suffix = attachmentPromptSuffix([{ filename: 'a.pdf' }, { filename: 'b.png' }])
  assert.ok(suffix.includes('/workspace/uploads/a.pdf'))
  assert.ok(suffix.includes('/workspace/uploads/b.png'))
})
