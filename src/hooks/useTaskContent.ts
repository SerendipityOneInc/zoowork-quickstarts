import { useQuery } from '@tanstack/react-query'
import { loadContent } from '../api.ts'
import { queryKeys, queryEnabled } from '../lib/queryKeys.ts'

/** Server snapshot of a task's prompts/frames. Disabled until a task is selected. The result
 *  is hydrated into the jotai conversation store (useConversation); live frames stream there. */
export function useTaskContent(taskId: string | null) {
  return useQuery({
    queryKey: queryKeys.taskContent(taskId ?? ''),
    queryFn: () => loadContent(taskId as string),
    enabled: queryEnabled.taskContent(taskId),
  })
}
