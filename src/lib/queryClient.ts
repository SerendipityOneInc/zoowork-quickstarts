import { QueryClient } from '@tanstack/react-query'

/**
 * Shared QueryClient defaults: brief stale window + always refetch on mount (so a
 * reload shows fresh server state), fail-fast on auth / not-found, retry transient
 * errors a few times. Our fetch layer (api.ts `json()`) throws
 * `"<METHOD> <path> failed: <status>"`, so we sniff the status from the message.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        refetchOnMount: 'always',
        retry: (failureCount, error) => {
          const msg = error instanceof Error ? error.message : ''
          if (/\bfailed: (401|403|404)\b/.test(msg)) return false
          return failureCount < 3
        },
      },
    },
  })
}
