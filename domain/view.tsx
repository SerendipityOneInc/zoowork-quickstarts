/**
 * domain/view.tsx — the FRONTEND business seam (the right-hand "bench" pane).
 *
 * The kit ships a generic two-pane shell: chat on the left, this <Bench> on the right.
 * By default Bench is the DebugPanel (a raw API / frame inspector — see the chat shell
 * for the conversational view). Replace it with your domain cards (tables, forms,
 * confirm gates, …) derived from `prompts`. This file may use React/DOM — it is bundled
 * into the frontend, never into the Worker.
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
