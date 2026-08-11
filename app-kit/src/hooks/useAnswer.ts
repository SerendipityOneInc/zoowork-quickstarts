import { useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { answerQuestion } from '../api.ts'
import type { Ask } from '../chat.ts'
import { taskIdAtom } from '../store/ui.ts'

/**
 * Returns `answer(ask, answer)` — submit the user's answer (an arbitrary JSON value: an option
 * pick `{ selectedOptions, customResponse? }`, or a form's `{ values }`) for a blocked
 * `ask_user_question` and let the turn resume. There is nothing to stream here: the blocked
 * prompt never left 'running', so its SSE is still attached (send() or the reload-reattach);
 * the worker posts a user.tool_confirmation to the Zooclaw session + nudges the runner, and
 * the agent's reply lands on that same stream. The card's optimistic "answered" state is the
 * component's concern.
 */
export function useAnswer() {
  const taskId = useAtomValue(taskIdAtom)
  return useCallback(
    async (ask: Ask, answer: unknown) => {
      if (!taskId) return
      try {
        await answerQuestion(taskId, { messageId: ask.messageId, actionId: ask.actionId, answer })
      } catch (e) {
        console.error('answer failed', e)
      }
    },
    [taskId],
  )
}
