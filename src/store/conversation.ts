import { atom } from 'jotai'
import type { PromptContent } from '../api.ts'
import { creatingAtom, taskIdAtom } from './ui.ts'

type TurnMap = Record<string, PromptContent[]>

// Working copy of turns per task. Seeded from the React Query `taskContent` query
// (server snapshot) and mutated live by SSE. Kept in jotai — NOT in the RQ cache — so
// half-streamed frames never leak into a persisted/refetched snapshot.
export const turnsAtom = atom<TurnMap>({})

/**
 * Merge a server snapshot into the store without clobbering richer live frames. By prompt id,
 * keep whichever copy has more frames (the live stream can be ahead of the server; an on-done
 * refetch lets the server catch up). Purely-local optimistic prompts (not yet in the snapshot)
 * are preserved. Idempotent — safe under StrictMode double-invoke and repeated refetches.
 */
export const hydrateTurnsAtom = atom(
  null,
  (get, set, { taskId, prompts }: { taskId: string; prompts: PromptContent[] }) => {
    const cur = get(turnsAtom)[taskId] ?? []
    const localById = new Map(cur.map((p) => [p.id, p]))
    const merged: PromptContent[] = prompts.map((sp) => {
      const lp = localById.get(sp.id)
      localById.delete(sp.id)
      return lp && lp.frames.length > sp.frames.length ? lp : sp
    })
    for (const p of cur) if (localById.has(p.id)) merged.push(p)
    set(turnsAtom, { ...get(turnsAtom), [taskId]: merged })
  },
)

/** Optimistically append a freshly-sent turn (empty frames) to a task. */
export const addTurnAtom = atom(
  null,
  (get, set, { taskId, prompt }: { taskId: string; prompt: PromptContent }) => {
    const cur = get(turnsAtom)[taskId] ?? []
    set(turnsAtom, { ...get(turnsAtom), [taskId]: [...cur, prompt] })
  },
)

/** Append a streamed frame to its prompt within a task (deduped by seq). */
export const appendFrameAtom = atom(
  null,
  (get, set, { taskId, promptId, seq, data }: { taskId: string; promptId: string; seq: number; data: unknown }) => {
    const cur = get(turnsAtom)[taskId]
    if (!cur) return
    set(turnsAtom, {
      ...get(turnsAtom),
      [taskId]: cur.map((p) =>
        p.id === promptId && !p.frames.some((f) => f.seq === seq)
          ? { ...p, frames: [...p.frames, { seq, data }] }
          : p,
      ),
    })
  },
)

/** Turns for the currently-open session (empty for a brand-new session). */
export const currentTurnsAtom = atom((get) => {
  const tid = get(taskIdAtom)
  return tid ? get(turnsAtom)[tid] ?? [] : []
})

// Busy is per-task, not global: a running session must never freeze the composer or leak its
// loading bubble into a different (or brand-new) session. The new-session createTask window is
// covered by `creatingAtom` (in ui.ts, so nav can clear it).
export const busyTasksAtom = atom<Set<string>>(new Set<string>())

export const markBusyAtom = atom(
  null,
  (get, set, { taskId, on }: { taskId: string; on: boolean }) => {
    const cur = get(busyTasksAtom)
    if (on === cur.has(taskId)) return
    const next = new Set(cur)
    if (on) next.add(taskId)
    else next.delete(taskId)
    set(busyTasksAtom, next)
  },
)

/** Busy state of the session you're looking at — the only thing the composer / loading
 *  bubble should read. */
export const currentBusyAtom = atom((get) => {
  const tid = get(taskIdAtom)
  return tid ? get(busyTasksAtom).has(tid) : get(creatingAtom)
})
