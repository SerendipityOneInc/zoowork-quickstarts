import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api.ts'

/** Statuses where retrying cannot help: the answer is "no", not "not yet". 401 in
 *  particular is the signed-out path (useMe is the sign-in gate), so retrying it just makes
 *  a logged-out user wait through three backoffs to be told so. */
const FINAL_STATUSES = new Set([401, 403, 404])

/**
 * Shared QueryClient defaults: brief stale window + always refetch on mount (so a
 * reload shows fresh server state), fail-fast on auth / not-found, retry transient
 * errors a few times. The status comes off `ApiError` (api.ts) — structurally, not by
 * matching the message text, so a route that answers with its own `error` string still
 * fails fast.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        refetchOnMount: 'always',
        retry: (failureCount, error) => {
          if (error instanceof ApiError && FINAL_STATUSES.has(error.status)) return false
          return failureCount < 3
        },
      },
    },
  })
}
