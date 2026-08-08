import { useQuery } from '@tanstack/react-query'
import { getConfig } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'

/** This deployment's runtime description (GET /api/app/config), rendered by the Debug
 *  panel's Config tab. Deployment shape only changes on redeploy, so it is fetched once
 *  per page load and never refetched. */
export function useConfig() {
  return useQuery({ queryKey: queryKeys.config(), queryFn: getConfig, staleTime: Infinity, retry: false })
}
