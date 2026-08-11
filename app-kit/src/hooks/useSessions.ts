import { useQuery } from '@tanstack/react-query'
import { listSessions } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'

/** The caller's sessions (newest first). Invalidated after create / turn-done. */
export function useSessions(enabled = true) {
  return useQuery({ queryKey: queryKeys.sessions(), queryFn: listSessions, enabled })
}
