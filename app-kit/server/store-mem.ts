/**
 * In-memory storage driver — for unit tests and local/offline runs. Implements the same
 * async `Store` contract (server/store.ts) as the D1 driver with plain Maps, so the whole
 * kit can be exercised without a database. This is what makes the contract core *testable*
 * (streaming-experience-contract: the pure-function layer that doesn't burn quota).
 *
 * Two fidelity choices keep it a faithful double of the D1 driver:
 *  - insertion order is tracked explicitly (`ord`) so list ordering is deterministic and
 *    matches `ORDER BY created_at` regardless of the clock;
 *  - `appendFrame` round-trips data through JSON, mirroring D1 storing it as a JSON string
 *    (so a stored frame is a structural clone, never a live reference).
 */
import type { Store, Task, Prompt, TaskSummary, ZooclawAgentRow, AgentBindingRow, Frame, AttachmentMeta } from './store.ts'

interface TaskRow extends Task {
  ord: number
}
interface PromptRow extends Prompt {
  ord: number
}

export function createMemStore(): Store {
  let ord = 0
  const now = (): string => new Date().toISOString()
  const tasks = new Map<string, TaskRow>()
  const prompts = new Map<string, PromptRow>()
  const frames = new Map<string, Frame[]>()
  const agents = new Map<string, ZooclawAgentRow>()
  const bindings = new Map<string, AgentBindingRow>()
  const attachments = new Map<string, { userEmail: string; filename: string; contentType: string; thumb: ArrayBuffer | null; large: ArrayBuffer | null }>()
  const promptFiles = new Map<string, string[]>()

  const toTask = (t: TaskRow): Task => ({
    id: t.id,
    project_id: t.project_id,
    status: t.status,
    session_id: t.session_id,
    agent_id: t.agent_id,
    user_email: t.user_email,
    created_at: t.created_at,
  })
  const toPrompt = (p: PromptRow): Prompt => ({
    id: p.id,
    task_id: p.task_id,
    prompt: p.prompt,
    status: p.status,
    created_at: p.created_at,
    completed_at: p.completed_at,
  })
  const firstPromptText = (taskId: string): string => {
    const ps = [...prompts.values()].filter((p) => p.task_id === taskId).sort((a, b) => a.ord - b.ord)
    return ps.length ? ps[0]!.prompt.slice(0, 80) : ''
  }

  return {
    async createTask(id, projectId, userEmail) {
      if (tasks.has(id)) return
      tasks.set(id, { id, project_id: projectId, status: 'running', session_id: null, agent_id: null, user_email: userEmail, created_at: now(), ord: ord++ })
    },
    async getTask(id) {
      const t = tasks.get(id)
      return t ? toTask(t) : undefined
    },
    async listTasksByUser(userEmail) {
      return [...tasks.values()]
        .filter((t) => t.user_email === userEmail)
        .sort((a, b) => b.ord - a.ord) // created_at DESC: newest first
        .map((t): TaskSummary => ({ id: t.id, status: t.status, created_at: t.created_at, title: firstPromptText(t.id) }))
    },
    async setTaskStatus(id, status) {
      const t = tasks.get(id)
      if (t) t.status = status
    },
    async setTaskSessionId(id, sessionId) {
      const t = tasks.get(id)
      if (t) t.session_id = sessionId
    },
    async setTaskAgentId(id, agentId) {
      const t = tasks.get(id)
      if (t) t.agent_id = agentId
    },

    async getAgentBinding(userEmail) {
      const b = bindings.get(userEmail)
      return b ? { agentId: b.agentId, agentName: b.agentName } : undefined
    },
    async saveAgentBinding(userEmail, agentId, agentName) {
      bindings.set(userEmail, { agentId, agentName }) // upsert: rebinding replaces
    },
    async deleteAgentBinding(userEmail) {
      bindings.delete(userEmail)
    },

    async getZooclawAgent(userEmail) {
      const a = agents.get(userEmail)
      return a ? { agentId: a.agentId, configHash: a.configHash } : undefined
    },
    async saveZooclawAgent(userEmail, agentId, configHash) {
      if (agents.has(userEmail)) return // INSERT OR IGNORE: first writer wins
      agents.set(userEmail, { agentId, configHash })
    },
    async setZooclawAgentConfig(userEmail, configHash) {
      const a = agents.get(userEmail)
      if (a) a.configHash = configHash
    },
    async deleteZooclawAgent(userEmail) {
      agents.delete(userEmail)
    },

    async createPrompt(id, taskId, prompt) {
      if (prompts.has(id)) return
      prompts.set(id, { id, task_id: taskId, prompt, status: 'running', created_at: now(), completed_at: null, ord: ord++ })
    },
    async getPrompt(id) {
      const p = prompts.get(id)
      return p ? toPrompt(p) : undefined
    },
    async listPrompts(taskId) {
      return [...prompts.values()]
        .filter((p) => p.task_id === taskId)
        .sort((a, b) => a.ord - b.ord) // created_at ASC
        .map(toPrompt)
    },
    async finishPrompt(id, status) {
      const p = prompts.get(id)
      if (p && p.status === 'running') {
        p.status = status
        p.completed_at = now()
      }
    },
    async setPromptStatus(id, status) {
      const p = prompts.get(id)
      if (p) p.status = status
    },

    async appendFrame(promptId, seq, data) {
      const arr = frames.get(promptId) ?? []
      arr.push({ seq, data: JSON.parse(JSON.stringify(data)) as unknown })
      arr.sort((a, b) => a.seq - b.seq)
      frames.set(promptId, arr)
    },
    async framesSince(promptId, fromSeq) {
      return (frames.get(promptId) ?? []).filter((f) => f.seq > fromSeq).map((f) => ({ seq: f.seq, data: f.data }))
    },

    async saveAttachment(fileId, userEmail, filename, contentType, thumb, large) {
      attachments.set(fileId, { userEmail, filename, contentType, thumb, large })
    },
    async getAttachment(fileId, size) {
      const a = attachments.get(fileId)
      if (!a) return undefined
      const bytes = size === 'large' ? a.large : a.thumb
      return bytes ? { userEmail: a.userEmail, bytes } : undefined
    },
    async linkPromptFiles(promptId, fileIds) {
      if (!promptFiles.has(promptId)) promptFiles.set(promptId, [...fileIds]) // INSERT OR IGNORE: first link wins
    },
    async listPromptAttachments(promptId) {
      return (promptFiles.get(promptId) ?? [])
        .map((fileId): AttachmentMeta | null => {
          const a = attachments.get(fileId)
          return a ? { fileId, filename: a.filename, contentType: a.contentType } : null
        })
        .filter((x): x is AttachmentMeta => x !== null)
    },
  }
}
