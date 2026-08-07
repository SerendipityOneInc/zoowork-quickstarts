import { AGENT_INSTRUCTION, SKILL_ID_PLACEHOLDER, TOOLS, defaultAgentConfig, type AgentConfig } from '../../domain/agent.ts'

/**
 * Agent settings: the system prompt + built-in tool toggles + skill id. The kit applies
 * these to the user's Zooclaw agent on the FIRST turn of a session (system prompt →
 * persona AGENTS.md, toggles → tool_policy, skill id → installed agent skill; all
 * drift-gated in worker/provision.ts), so changes take effect on the NEXT new chat. A
 * live session keeps the config it was created with.
 *
 * This is kit UI (configuring the Zooclaw agent), distinct from domain/view.tsx (the
 * business pane). It edits a plain AgentConfig; App owns the state + persistence.
 */
export function SettingsPanel({
  config,
  onChange,
  appliesToNewChat,
}: {
  config: AgentConfig
  onChange: (next: AgentConfig) => void
  /** True when a session is open → these settings apply only to the next new chat. */
  appliesToNewChat: boolean
}) {
  const setTool = (key: string, on: boolean) => onChange({ ...config, tools: { ...config.tools, [key]: on } })

  return (
    <div className="settings">
      <div className="settings-head">
        <span className="settings-title">Agent settings</span>
        <button
          className="ghost settings-reset"
          onClick={() => onChange(defaultAgentConfig())}
          title="Restore the default system prompt and tool switches"
        >
          Reset
        </button>
      </div>

      <label className="settings-label" htmlFor="skill-id">Skill ID</label>
      <textarea
        id="skill-id"
        className="settings-textarea"
        value={config.skillId ?? ''}
        placeholder={SKILL_ID_PLACEHOLDER}
        onChange={(e) => onChange({ ...config, skillId: e.target.value })}
        rows={2}
        spellCheck={false}
      />
      <p className="settings-hint muted">
        Paste a skill id (<code>skl_...</code>) to install it on your agent. The version is <b>not pinned</b> - it follows the latest ready version. Leave blank to install nothing. Only skills your own organization has uploaded can be installed.
      </p>

      <label className="settings-label" htmlFor="sys-prompt">System prompt</label>
      <textarea
        id="sys-prompt"
        className="settings-textarea"
        value={config.systemPrompt}
        placeholder={AGENT_INSTRUCTION}
        onChange={(e) => onChange({ ...config, systemPrompt: e.target.value })}
        rows={5}
      />

      <div className="settings-label">Tools</div>
      <div className="settings-tools">
        {TOOLS.map((t) => {
          const on = config.tools[t.key] ?? t.defaultOn
          return (
            <label key={t.key} className="tool-row">
              <input type="checkbox" checked={on} onChange={(e) => setTool(t.key, e.target.checked)} />
              <span className="tool-text">
                <span className="tool-label">{t.label}</span>
                <span className="tool-desc muted">{t.description}</span>
              </span>
            </label>
          )
        })}
      </div>

      <p className="settings-hint muted">
        {appliesToNewChat ? 'Applies to the next new chat. The current chat keeps the settings it was created with.' : 'Start a new chat and send - it will be created with the settings above.'}
      </p>
    </div>
  )
}
