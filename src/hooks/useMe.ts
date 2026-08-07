import { useQuery } from '@tanstack/react-query'
import { getMe } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'

/** The signed-in user (from the auth provider). `isError` (401) → unauthenticated. */
export function useMe() {
  return useQuery({ queryKey: queryKeys.me(), queryFn: getMe })
}
