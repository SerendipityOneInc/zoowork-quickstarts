/**
 * Server state for the Agent tab: which agent the next new chat will use, the org's agent
 * directory (when the gateway forwards it), and the three writes that change the answer.
 *
 * Both queries opt out of the client-wide `refetchOnMount: 'always'` (src/lib/queryClient.ts).
 * That default exists so a reload shows fresh conversation state; here it would mean a fresh
 * `getAgent()` — and a fresh whole-org `listAgents()` — every time the user clicks between
 * the four tabs, since the panel mounts one tab at a time. Neither answer can change without
 * a mutation below, and those write the new value straight into the cache.
 */
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { bindAgent, getEffectiveAgent, listAgents, startAgent, unbindAgent, type EffectiveAgent } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'

/** The agent a NEW chat would use. Cheap and provisioning-free server-side. */
export function useEffectiveAgent() {
  return useQuery({ queryKey: queryKeys.effectiveAgent(), queryFn: getEffectiveAgent, staleTime: 30_000, refetchOnMount: true, retry: false })
}

/**
 * The org's agents. Only mounted when the picker is enabled, so the 403 arm never runs. A
 * gateway that does not forward the collection GET resolves to `{ available: false }` — a
 * value, not an error, which is why `retry` is off (there is nothing to retry) and the
 * degraded UI reads it straight off `data`. Any OTHER failure does reject, and lands in the
 * component's error branch.
 */
export function useAgentDirectory() {
  return useQuery({ queryKey: queryKeys.agentDirectory(), queryFn: listAgents, staleTime: 30_000, refetchOnMount: true, retry: false })
}

/** Bind and unbind both ANSWER with the new effective agent, so write it into the cache
 *  rather than invalidating and asking the same question a third time. Neither changes any
 *  agent's own state, so the directory is left alone. */
function useSeedEffectiveAgent(): (next: EffectiveAgent) => void {
  const qc = useQueryClient()
  return (next) => {
    qc.setQueryData(queryKeys.effectiveAgent(), next)
  }
}

export function useBindAgent(): UseMutationResult<EffectiveAgent, Error, string> {
  return useMutation({ mutationFn: bindAgent, onSuccess: useSeedEffectiveAgent() })
}

export function useUnbindAgent(): UseMutationResult<EffectiveAgent, Error, void> {
  return useMutation({ mutationFn: unbindAgent, onSuccess: useSeedEffectiveAgent() })
}

/** Starting an agent DOES change upstream state (`desired_state`), and it is the one row the
 *  panel shows a state pill for — so both views have to re-read it. */
export function useStartAgent(): UseMutationResult<{ ok: boolean }, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: startAgent,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.effectiveAgent() }),
        qc.invalidateQueries({ queryKey: queryKeys.agentDirectory() }),
      ])
    },
  })
}
