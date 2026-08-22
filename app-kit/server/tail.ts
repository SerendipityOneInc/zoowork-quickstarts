/**
 * Live SSE tail (streaming-experience-contract I1): the live stream is NOT a connection to
 * the agent — it's tailing the store by seq. Poll `framesSince(lastSeq)`, write each new
 * frame as an SSE line, and when the prompt leaves 'running' drain the final frames and
 * write a `done`. `write` and `isAlive` are injected so the loop is unit-testable without
 * an HTTP stream (the route passes stream.write + a !aborted flag).
 *
 * This is plain store-tailing — it never touches the relay — so it survives a backend
 * swap unchanged (only the SSE carrier and the Store driver change).
 *
 * The seq here is the KIT'S OWN frame seq (assigned by the DO as it appends to the
 * Store), deliberately numeric and unrelated to the ZooClaw session-event lane — that
 * lane resumes on opaque server-minted cursor tokens (server/zooclaw/turn-driver.ts) and
 * its seqs never reach this file.
 */
import type { Store } from './store.ts'

export interface TailDeps {
  /** Injected for tests; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Poll interval between store reads while the turn is still running. */
  pollMs?: number
}

export async function tailFrames(
  store: Store,
  promptId: string,
  fromSeq: number,
  write: (line: string) => void | Promise<void>,
  isAlive: () => boolean,
  deps: TailDeps = {},
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 150
  let lastSeq = fromSeq

  const flush = async (): Promise<void> => {
    for (const f of await store.framesSince(promptId, lastSeq)) {
      await write(`id: ${f.seq}\ndata: ${JSON.stringify(f.data)}\n\n`)
      lastSeq = f.seq
    }
  }

  while (isAlive()) {
    await flush()
    const cur = await store.getPrompt(promptId)
    if (cur && cur.status !== 'running') {
      await flush() // drain frames appended between the read and the status check
      await write(`event: done\ndata: ${JSON.stringify({ status: cur.status })}\n\n`)
      return
    }
    await sleep(pollMs)
  }
}
