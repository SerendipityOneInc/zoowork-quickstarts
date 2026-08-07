import { useCallback } from 'react'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { createTask, followup, toAttachment, type Attachment, type SentAttachment } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'
import { attachStream } from '../lib/stream.ts'
import { configAtom, creatingAtom, navEpochAtom, taskIdAtom } from '../store/ui.ts'
import { addTurnAtom, busyTasksAtom, markBusyAtom } from '../store/conversation.ts'

// The Provider-less default store — lets us read live atom values AFTER an await (closures
// captured stale values at call time).
const store = getDefaultStore()

/**
 * Returns `send(text)` — the one turn-driver. New session → createTask (applying the current
 * agent config), otherwise followup; then optimistically add the turn, mark THIS task busy,
 * and stream frames into the jotai store. On done it clears that task's busy and refetches
 * sessions + this task's content.
 *
 * Busy/creating guards are per-session, so a running task never blocks sending from a
 * different or brand-new session.
 */
export function useSendMessage() {
  const qc = useQueryClient()
  const taskId = useAtomValue(taskIdAtom)
  const busyTasks = useAtomValue(busyTasksAtom)
  const creating = useAtomValue(creatingAtom)
  const setTaskId = useSetAtom(taskIdAtom)
  const setCreating = useSetAtom(creatingAtom)
  const addTurn = useSetAtom(addTurnAtom)
  const markBusy = useSetAtom(markBusyAtom)

  return useCallback(
    async (text: string, atts?: SentAttachment[]) => {
      const sessionId = taskId
      // Re-entry guard scoped to the targeted session; other sessions stay free.
      if (sessionId) {
        if (busyTasks.has(sessionId)) return
      } else {
        if (creating) return
        setCreating(true)
      }
      let tid = sessionId
      try {
        // Attachments were already uploaded by the composer (eager, on paste/drop). Build the
        // optimistic bubble with the SAME toAttachment helper the reload path uses (I0); the file
        // refs that ride on the turn are just a projection of it.
        const attachments: Attachment[] | undefined = atts?.length
          ? atts.map((a) => toAttachment({ fileId: a.id, filename: a.filename, contentType: a.contentType }))
          : undefined
        const refs = attachments?.map((a) => ({ id: a.fileId, filename: a.filename }))
        let pid: string
        if (!tid) {
          const epochBefore = store.get(navEpochAtom)
          const r = await createTask(text, store.get(configAtom), refs)
          tid = r.taskId
          pid = r.promptId
          // Only adopt the new task as the current view if the user hasn't navigated to
          // another (or a fresh) session while createTask was in flight. The task still
          // runs in the background and shows in the session list either way.
          if (store.get(navEpochAtom) === epochBefore) setTaskId(r.taskId)
          void qc.invalidateQueries({ queryKey: queryKeys.sessions() })
        } else {
          const r = await followup(tid, text, refs)
          pid = r.promptId
        }
        const ttid = tid
        addTurn({ taskId: ttid, prompt: { id: pid, prompt: text, frames: [], attachments } })
        // Open the live stream (busy + frame append + on-done refetch). Shared with the
        // reload-reattach path (useConversation) via lib/stream.ts so it's never doubled.
        attachStream(qc, ttid, pid)
      } catch (e) {
        console.error(e)
        if (tid) markBusy({ taskId: tid, on: false })
      } finally {
        setCreating(false)
      }
    },
    [taskId, busyTasks, creating, qc, setTaskId, setCreating, addTurn, markBusy],
  )
}
