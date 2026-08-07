/**
 * Cloudflare D1 storage driver — the production (and, via `wrangler dev`, the local)
 * store. Implements the async `Store` contract (server/store.ts) over a D1Database
 * binding, so call sites never see the driver.
 *
 * The SQL is plain SQLite (`?` placeholders, `datetime('now')`) — D1 IS SQLite, so it
 * runs verbatim. Schema lives in migrations/0001_init.sql (applied via
 * `wrangler d1 migrations apply`), so this file does no CREATE TABLE at runtime.
 * To target Postgres/MySQL instead, add a sibling store-pg.ts with the same shape.
 */
import type { Store, Task, Prompt, TaskSummary, ZooclawAgentRow, AttachmentMeta } from './store.ts'

export function createD1Store(db: D1Database): Store {
  return {
    async createTask(id, projectId, userEmail) {
      await db
        .prepare(`INSERT INTO tasks (id, project_id, user_email) VALUES (?, ?, ?)`)
        .bind(id, projectId, userEmail)
        .run()
    },
    async getTask(id) {
      return (await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first<Task>()) ?? undefined
    },
    async listTasksByUser(userEmail) {
      const { results } = await db
        .prepare(
          `SELECT t.id, t.status, t.created_at,
                  COALESCE((SELECT substr(p.prompt, 1, 80) FROM prompts p
                            WHERE p.task_id = t.id ORDER BY p.created_at LIMIT 1), '') AS title
             FROM tasks t WHERE t.user_email = ? ORDER BY t.created_at DESC`,
        )
        .bind(userEmail)
        .all<TaskSummary>()
      return results
    },
    async setTaskStatus(id, status) {
      await db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).bind(status, id).run()
    },
    async setTaskSessionId(id, sessionId) {
      await db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).bind(sessionId, id).run()
    },

    async getZooclawAgent(userEmail) {
      const row = await db
        .prepare(`SELECT agent_id AS agentId, config_hash AS configHash FROM zooclaw_agents WHERE user_email = ?`)
        .bind(userEmail)
        .first<ZooclawAgentRow>()
      return row ?? undefined
    },
    async saveZooclawAgent(userEmail, agentId, configHash) {
      await db
        .prepare(`INSERT OR IGNORE INTO zooclaw_agents (user_email, agent_id, config_hash) VALUES (?, ?, ?)`)
        .bind(userEmail, agentId, configHash)
        .run()
    },
    async setZooclawAgentConfig(userEmail, configHash) {
      await db.prepare(`UPDATE zooclaw_agents SET config_hash = ? WHERE user_email = ?`).bind(configHash, userEmail).run()
    },
    async deleteZooclawAgent(userEmail) {
      await db.prepare(`DELETE FROM zooclaw_agents WHERE user_email = ?`).bind(userEmail).run()
    },

    async createPrompt(id, taskId, prompt) {
      await db.prepare(`INSERT INTO prompts (id, task_id, prompt) VALUES (?, ?, ?)`).bind(id, taskId, prompt).run()
    },
    async getPrompt(id) {
      return (await db.prepare(`SELECT * FROM prompts WHERE id = ?`).bind(id).first<Prompt>()) ?? undefined
    },
    async listPrompts(taskId) {
      const { results } = await db
        .prepare(`SELECT * FROM prompts WHERE task_id = ? ORDER BY created_at`)
        .bind(taskId)
        .all<Prompt>()
      return results
    },
    async finishPrompt(id, status) {
      await db
        .prepare(`UPDATE prompts SET status = ?, completed_at = datetime('now') WHERE id = ? AND status = 'running'`)
        .bind(status, id)
        .run()
    },
    async setPromptStatus(id, status) {
      await db.prepare(`UPDATE prompts SET status = ? WHERE id = ?`).bind(status, id).run()
    },

    async appendFrame(promptId, seq, data) {
      await db
        .prepare(`INSERT INTO frames (prompt_id, seq, data) VALUES (?, ?, ?)`)
        .bind(promptId, seq, JSON.stringify(data))
        .run()
    },
    async framesSince(promptId, fromSeq) {
      const { results } = await db
        .prepare(`SELECT seq, data FROM frames WHERE prompt_id = ? AND seq > ? ORDER BY seq`)
        .bind(promptId, fromSeq)
        .all<{ seq: number; data: string }>()
      return results.map((r) => ({ seq: r.seq, data: JSON.parse(r.data) as unknown }))
    },

    async saveAttachment(fileId, userEmail, filename, contentType, thumb, large) {
      await db
        .prepare(`INSERT OR REPLACE INTO attachments (file_id, user_email, filename, content_type, thumb, large) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(fileId, userEmail, filename, contentType, thumb, large)
        .run()
    },
    async getAttachment(fileId, size) {
      const col = size === 'large' ? 'large' : 'thumb' // closed set → safe to inline
      const row = await db
        .prepare(`SELECT user_email AS userEmail, ${col} AS bytes FROM attachments WHERE file_id = ?`)
        .bind(fileId)
        .first<{ userEmail: string; bytes: ArrayBuffer | ArrayBufferView | number[] | null }>()
      if (!row || row.bytes == null) return undefined
      // D1 returns a BLOB as ArrayBuffer (prod Workers) or number[] (local miniflare). Copy into a
      // fresh ArrayBuffer — else c.body() stringifies a number[] into a corrupt CSV of byte values.
      const b = row.bytes
      const src = b instanceof ArrayBuffer
        ? new Uint8Array(b)
        : ArrayBuffer.isView(b)
          ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
          : Uint8Array.from(b)
      const bytes = new ArrayBuffer(src.byteLength)
      new Uint8Array(bytes).set(src)
      return { userEmail: row.userEmail, bytes }
    },
    async linkPromptFiles(promptId, fileIds) {
      for (let i = 0; i < fileIds.length; i++) {
        await db
          .prepare(`INSERT OR IGNORE INTO prompt_files (prompt_id, idx, file_id) VALUES (?, ?, ?)`)
          .bind(promptId, i, fileIds[i])
          .run()
      }
    },
    async listPromptAttachments(promptId) {
      const { results } = await db
        .prepare(
          `SELECT a.file_id AS fileId, a.filename AS filename, a.content_type AS contentType
             FROM prompt_files pf JOIN attachments a ON a.file_id = pf.file_id
            WHERE pf.prompt_id = ? ORDER BY pf.idx`,
        )
        .bind(promptId)
        .all<AttachmentMeta>()
      return results
    },
  }
}
