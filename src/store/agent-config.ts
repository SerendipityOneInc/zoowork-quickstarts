/**
 * The agent config the UI edits (system prompt + tool toggles + skill pin), persisted so it
 * survives reload and sent on createTask — the first turn applies it to the user's agent.
 *
 * It lives here rather than in store/ui.ts because store/ui.ts reads `location` at module
 * load (the ?t= session atom), which makes it un-importable outside a browser. Two panes
 * need this atom — the settings editor and the Debug panel's Config tab, and the latter is
 * imported by the kit's node-run unit tests (src/chat.test.ts). store/ui.ts re-exports it,
 * so existing imports are unaffected.
 *
 * The `zak-` key is fresh, so no template-era stored shape can be rehydrated.
 */
import { atomWithStorage } from 'jotai/utils'
import { defaultAgentConfig, type AgentConfig } from '../../domain/agent.ts'

export const configAtom = atomWithStorage<AgentConfig>('zak-agent-config', defaultAgentConfig())
