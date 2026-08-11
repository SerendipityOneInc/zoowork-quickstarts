-- Agent binding: let a user point this deployment at an agent they already own in the
-- ZooClaw app, instead of the env-fixed one or a kit-provisioned one.
--
-- Two independent pieces, both required:
--
--   tasks.agent_id — the agent a CONVERSATION is pinned to, written when its first turn
--     resolves one. Without it, changing the binding would send an existing conversation's
--     follow-up to the NEW agent while its session id still belongs to the OLD one, and
--     every reply would come back `session not found`. Sessions are agent-scoped; the pin
--     is what keeps old conversations alive across a rebind.
--
--   agent_bindings — the user's chosen agent. Deliberately NOT a reuse of zooclaw_agents:
--     that table means "the agent this kit CREATED for this user" and carries the
--     config_hash drift gate, so a borrowed agent living there would make the next turn PUT
--     the kit's persona/tool_policy over somebody's real agent (see worker/provision.ts).
--     Different meaning, different table — a bound agent is used, never configured.

ALTER TABLE tasks ADD COLUMN agent_id TEXT;

CREATE TABLE IF NOT EXISTS agent_bindings (
  user_email TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  -- Display name captured at bind time, so the panel can label the binding without an
  -- upstream round-trip (and can still show something if the agent later 404s).
  agent_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
