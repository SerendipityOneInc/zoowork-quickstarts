/**
 * domain/view.tsx — the FRONTEND business seam (the right-hand "bench" pane).
 *
 * The kit ships a generic two-pane shell: chat on the left, this <Bench> on the right.
 * By default Bench is the four-tab agent panel (Agent / Config / Runtime / Debug — which
 * agent you are on, what the kit applies to it, how the deployment is wired, and the raw
 * frames). Replace it with your domain cards (tables, forms, confirm gates, …) derived from
 * `prompts` — note that replacing it also removes the agent-settings editor, which lives in
 * the Config tab. This file may use React/DOM — it is bundled into the frontend, never into
 * the Worker.
 *
 * `prompts` is the full transcript for the current conversation: each prompt carries its
 * raw stream-json `frames`. Walk them to build your domain state (for an example of a
 * frame → domain-state machine).
 */
import type { PromptContent } from '../src/api.ts'
import { DebugPanel } from '../src/components/DebugPanel.tsx'

export function Bench({ prompts }: { prompts: PromptContent[] }) {
  return <DebugPanel prompts={prompts} />
}
