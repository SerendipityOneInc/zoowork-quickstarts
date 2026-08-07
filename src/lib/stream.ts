import { getDefaultStore } from 'jotai'
import type { QueryClient } from '@tanstack/react-query'
import { streamPrompt } from '../api.ts'
import { queryKeys } from './queryKeys.ts'
import { appendFrameAtom, markBusyAtom } from '../store/conversation.ts'

// The Provider-less default jotai store — set atoms from this plain module (not a hook).
const store = getDefaultStore()

// Active SSE closers keyed by promptId. Shared by BOTH the send() path and the
// reload-reattach path so the same in-flight turn is never streamed twice.
const activeStreams = new Map<string, () => void>()

/**
 * Open (or reuse) the live SSE stream for a prompt: mark its task busy, append streamed
 * frames into the jotai conversation store, and on `done` clear busy + refetch the server
 * snapshot (sessions + this task's content).
 *
 * Idempotent per promptId: a second call while one is already open is a no-op, so send()
 * and the reload-reattach (useConversation) can't double-stream the same turn.
 *
 * `fromSeq` resumes after the frames already loaded into the store — the reattach passes the
 * highest seq it hydrated so a browser reload re-joins an in-flight turn without duplicating
 * frames (the SSE endpoint streams only seq > fromSeq). The turn keeps streaming across
 * session navigation (closed on `done`, never on unmount).
 */
export function attachStream(qc: QueryClient, taskId: string, promptId: string, fromSeq = 0): void {
  if (activeStreams.has(promptId)) return
  store.set(markBusyAtom, { taskId, on: true })
  const stop = streamPrompt(
    promptId,
    (seq, data) => store.set(appendFrameAtom, { taskId, promptId, seq, data }),
    () => {
      store.set(markBusyAtom, { taskId, on: false })
      activeStreams.delete(promptId)
      void qc.invalidateQueries({ queryKey: queryKeys.sessions() })
      void qc.invalidateQueries({ queryKey: queryKeys.taskContent(taskId) })
    },
    fromSeq,
  )
  activeStreams.set(promptId, stop)
}
