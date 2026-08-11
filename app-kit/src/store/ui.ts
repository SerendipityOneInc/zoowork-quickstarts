import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** The edited agent config. Defined in store/agent-config.ts (see the note there: this
 *  module touches `location` at load, so it cannot be imported outside a browser) and
 *  re-exported here, which is where the rest of the app already looks for it. */
export { configAtom } from './agent-config.ts'

// The current session lives in the URL (?t=…) so refresh / deep-link restores it.
// Identity comes from the auth provider, so a session belongs to a user, not a tab.
function readUrlTaskId(): string | null {
  return new URLSearchParams(location.search).get('t')
}
function writeUrlTaskId(id: string | null): void {
  const u = new URL(location.href)
  if (id) u.searchParams.set('t', id)
  else u.searchParams.delete('t')
  history.replaceState(null, '', u)
}

const _taskIdAtom = atom<string | null>(readUrlTaskId())
/** Current session id. Reads are plain; writes also mirror to the URL (?t=). */
export const taskIdAtom = atom(
  (get) => get(_taskIdAtom),
  (_get, set, id: string | null) => {
    set(_taskIdAtom, id)
    writeUrlTaskId(id)
  },
)

/** Mobile session drawer open/closed. */
export const navOpenAtom = atom(false)

/** Debug pane visibility — gates the right-hand bench (settings + DebugPanel) and the
 *  mobile pane-toggle. Defaults ON so the kit is dev-friendly out of the box. Tap the
 *  brand 5× quickly to toggle it (hide it for a clean product view, or bring it back —
 *  see App.tsx); flip this default to `false` to ship clean by default. Session-only — a
 *  refresh returns to this default. */
export const debugAtom = atom(true)

// Light/dark, persisted as a raw string (default JSON storage would fail to parse a
// legacy raw value).
const rawThemeStorage = {
  getItem: (key: string, initial: 'light' | 'dark'): 'light' | 'dark' => {
    try {
      const v = localStorage.getItem(key)
      return v === 'dark' || v === 'light' ? v : initial
    } catch {
      return initial
    }
  },
  setItem: (key: string, value: 'light' | 'dark') => {
    try { localStorage.setItem(key, value) } catch { /* ignore */ }
  },
  removeItem: (key: string) => {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  },
}
export const themeAtom = atomWithStorage<'light' | 'dark'>('zak-theme', 'light', rawThemeStorage)

// A brand-new session has no taskId yet, so its first send is "busy" only via this flag
// during the createTask round-trip. Lives here so nav actions can clear it.
export const creatingAtom = atom(false)

// Bumped on every explicit session navigation (new / open). An in-flight createTask
// snapshots this before awaiting and, if it changed, declines to adopt its task as the
// current view — so a slow POST can't yank the user back after they've moved on.
export const navEpochAtom = atom(0)

/** Reset to a brand-new session. */
export const newSessionAtom = atom(null, (get, set) => {
  set(taskIdAtom, null)
  set(navOpenAtom, false)
  set(creatingAtom, false)
  set(navEpochAtom, get(navEpochAtom) + 1)
})

/** Open an existing session: switch task, close the mobile drawer. */
export const openSessionAtom = atom(null, (get, set, id: string) => {
  set(taskIdAtom, id)
  set(navOpenAtom, false)
  set(creatingAtom, false)
  set(navEpochAtom, get(navEpochAtom) + 1)
})
