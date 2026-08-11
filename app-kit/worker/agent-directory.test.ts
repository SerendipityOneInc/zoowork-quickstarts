/**
 * The picker's directory: what reaches the browser, and — the part worth pinning — what
 * gets REMOVED from a user's list and why. Fixtures are the real label sets observed on
 * staging 2026-08-10 (an Agent Builder test run, a workspace install, a kit-provisioned
 * agent), because the whole rule turns on which labels an agent happens to carry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBuilderTestRun, labelsOf, toAgentSummary, toDirectory } from './agent-directory.ts'
import type { AgentRecord } from '@zooclaw-agents/sdk'

const agent = (agent_id: string, name: string, labels: Record<string, unknown>, desired = 'running'): AgentRecord =>
  ({ agent_id, declared: { name, labels }, labels, status: { desired_state: desired } }) as unknown as AgentRecord

/** Same pack, same name, installed into a workspace — what the user recognises. */
const INSTALLED = agent('agt_installed', '平价穿搭复刻助手', {
  pack_id: 'f2f964c28f564c7192145274f605e06b',
  pack_version: '1.0.0',
  workspace_id: '1fb46466f9be4cc995da37ca1f6bd785',
})
/** Its twin from a "try it" click in the Agent Builder: identical name, no workspace. */
const TEST_RUN = agent('agt_testrun', '平价穿搭复刻助手', {
  source: 'agent_builder',
  display_id: 'affordable-fashion-finder',
  pack_version: '1.0.0',
  pack_test_run_id: 'ptr_734f6973078e4189bf2aded903a4bb5e',
})
/** What worker/provision.ts createResourceFor stamps on the kit's own per-user agent. */
const KIT_OWN = agent('agt_kit', 'app-kit: u@x.com', { app: 'zooclaw-app-kit', user: 'u@x.com' }, 'stopped')

test('toAgentSummary keeps only what the picker renders', () => {
  assert.deepEqual(toAgentSummary(INSTALLED), {
    agentId: 'agt_installed',
    name: '平价穿搭复刻助手',
    workspaceId: '1fb46466f9be4cc995da37ca1f6bd785',
    desiredState: 'running',
  })
  // No persona, no skills, no ownership — a list row must not ship somebody's prompt.
  assert.deepEqual(Object.keys(toAgentSummary(INSTALLED)).sort(), ['agentId', 'desiredState', 'name', 'workspaceId'])
})

test('toAgentSummary tolerates an agent with no name, labels or status', () => {
  assert.deepEqual(toAgentSummary({ agent_id: 'agt_bare' } as unknown as AgentRecord), {
    agentId: 'agt_bare',
    name: null,
    workspaceId: null,
    desiredState: null,
  })
})

test('labelsOf falls back to the top-level copy when `declared` carries none', () => {
  const topLevelOnly = { agent_id: 'a', labels: { workspace_id: 'ws' } } as unknown as AgentRecord
  assert.deepEqual(labelsOf(topLevelOnly), { workspace_id: 'ws' })
  assert.deepEqual(labelsOf({ agent_id: 'a' } as unknown as AgentRecord), {})
})

test('only Agent Builder test runs are dropped — NOT every agent that lacks a workspace_id', () => {
  assert.equal(isBuilderTestRun(TEST_RUN), true)
  assert.equal(isBuilderTestRun(INSTALLED), false)
  // The trap this rule exists to avoid: the kit's OWN per-user agent has no workspace_id
  // either, and filtering on the absent field would hide the agent a default deployment
  // just created for the person reading the list.
  assert.equal(labelsOf(KIT_OWN).workspace_id, undefined)
  assert.equal(isBuilderTestRun(KIT_OWN), false)
})

test('either test-run label is enough (the pair travels together, but neither is promised)', () => {
  assert.equal(isBuilderTestRun(agent('a', 'x', { pack_test_run_id: 'ptr_1' })), true)
  assert.equal(isBuilderTestRun(agent('a', 'x', { source: 'agent_builder' })), true)
  assert.equal(isBuilderTestRun(agent('a', 'x', { source: 'somewhere_else' })), false)
})

test('toDirectory drops the twin and REPORTS the count (no silent trim)', () => {
  const dir = toDirectory([INSTALLED, TEST_RUN, KIT_OWN])
  assert.deepEqual(dir.agents.map((a) => a.agentId), ['agt_installed', 'agt_kit'])
  // The count is what keeps the list honest against what listAgents() actually returned.
  assert.equal(dir.hidden, 1)
  assert.equal(dir.available, true)
})

test('toDirectory on an empty org hides nothing', () => {
  assert.deepEqual(toDirectory([]), { available: true, agents: [], hidden: 0 })
})
