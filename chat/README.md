# chat

> A template in [ZooClaw Quickstarts](../README.md). The smallest thing that talks to your agent.

Two values, two commands, a chat box. No database, no build step, no framework — about
250 lines you can read in one sitting.

## Run it

```bash
cp .env.example .env      # paste your ZOOCLAW_API_KEY and ZOOCLAW_AGENT_ID
pnpm install
pnpm dev                  # http://localhost:3000
```

Both values are copied from the ZooClaw workspace UI: the API key from your org admin,
the agent id (`agt_…`) from your agent's detail dialog.

That is the whole setup. The agent is one you already built — this template creates
nothing and configures nothing.

## What it does

- **Talks to your agent.** One conversation, multi-turn. The platform holds the context,
  so follow-ups never re-send history.
- **Rebuilds on reload.** The browser stores only a session id; the transcript is fetched
  back from ZooClaw. Nothing is stored on the server.
- **Says what the agent is doing.** `thinking…`, `using web_search…` — driven by real
  events, not a fake typing animation (see below).
- **Keeps your key server-side.** That is the only reason `server.mjs` exists.

## What it does not do

No login, no session list, no file uploads, no persistence of its own. Those are not
oversights — they are the next template's problem. When you need them, read
[`app-kit/`](../app-kit/), which does all four.

## Three things worth knowing

**Replies arrive whole, not token by token.** One `agent.assistant` event carries the
entire message. There is no delta stream to subscribe to, so a typing cursor would be a
lie — the template shows what the agent is actually doing instead.

**Your own messages are not in the event log.** Its 19 event types are all `run.*` and
`agent.*`. Rebuilding a transcript from `listEvents` gives you assistant bubbles and
nothing else. The transcript lives on `getSession(…, { history: true })`.

**The API key authenticates your whole organization.** Anyone holding it can read and
modify every agent in your org and every session under them. There is no per-user or
read-only variant. Keep it in the server.

## Files

| | |
|---|---|
| [`server.mjs`](server.mjs) | the whole backend — three routes, no framework |
| [`web/index.html`](web/index.html) | the whole frontend — one file, no build |
| [`skill.md`](skill.md) | the gotchas, written for a coding assistant |

## Change it

Your assistant already knows this platform — the repo vendors the ZooClaw skill at
[`../.agents/skills/`](../.agents/skills/). Open your assistant in this directory and ask
for what you want. `skill.md` here covers what is specific to this template.
