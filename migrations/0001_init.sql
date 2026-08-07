-- zooclaw-app-kit schema (D1). Plain SQLite DDL — D1 runs it verbatim.
-- Three tables mirror the turn model (see server/store.ts):
--   tasks   — one conversation (the backing Zooclaw session id lives here)
--   prompts — one agent turn within a task
--   frames  — one stream-json line of agent output, ordered by seq
-- Plus zooclaw_agents (one provisioned Zooclaw Agent per user; tenant = email) and the
-- attachment display channel (attachments + prompt_files). Single migration on purpose:
-- this is a fresh template with no deployed databases, so there is no history to preserve.

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  -- The Zooclaw session backing this conversation. NULL until the first turn creates it
  -- (sessions are minted lazily by the DO — see worker/task-do.ts).
  session_id TEXT,
  user_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_email);

CREATE TABLE IF NOT EXISTS prompts (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prompts_task ON prompts(task_id);

-- frames are the streaming source of truth (streaming-experience-contract I0):
-- every read path (live tail + refresh rebuild) comes from here, never from the API.
CREATE TABLE IF NOT EXISTS frames (
  prompt_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  data      TEXT NOT NULL,
  PRIMARY KEY (prompt_id, seq)
);

-- One row per user: their Zooclaw Agent (provisioned lazily on first turn — see
-- worker/provision.ts). `config_hash` fingerprints the last agent config this kit
-- applied, so a turn only PUTs actual drift (every API PUT bumps config_version
-- even when nothing changed — see the API reference).
CREATE TABLE IF NOT EXISTS zooclaw_agents (
  user_email  TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  config_hash TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Image attachment display channel. The UPLOAD path ships disabled (domain/agent.ts
-- ATTACHMENTS_ENABLED: Zooclaw Files is not production-wired), but the display schema
-- stays so a vertical can re-enable uploads without a migration.
-- `attachments`: one row per uploaded file id. Keeps two WebP renditions as BLOBs — a
--   small inline thumbnail + a larger lightbox image. Kept in D1 on purpose: both
--   renditions are < ~250KB (screenshots), the size band where reading a BLOB from
--   SQLite beats the filesystem (sqlite.org/fasterthanfs). Non-image files keep
--   metadata only (thumb/large NULL) and render as a filename chip.
-- `prompt_files`: ordered association of a prompt → the file ids it carries (for the bubble).
-- The bytes are served by an authed Worker route (GET /api/app/files/:id?size=thumb|large),
-- scoped to attachments.user_email — never a public/CDN/signed-storage URL.

CREATE TABLE IF NOT EXISTS attachments (
  file_id      TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  thumb        BLOB,
  large        BLOB,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_email);

CREATE TABLE IF NOT EXISTS prompt_files (
  prompt_id TEXT    NOT NULL,
  idx       INTEGER NOT NULL,
  file_id   TEXT    NOT NULL,
  PRIMARY KEY (prompt_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_prompt_files_prompt ON prompt_files(prompt_id);
