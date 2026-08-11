# ZooClaw Quickstarts

Runnable templates for building on **ZooClaw Managed Agents**. Each directory is a
self-contained app: clone the repo, work in one directory, run it.

You need two values, both copied from the ZooClaw workspace UI:

| | |
|---|---|
| `ZOOCLAW_API_KEY` | `zct_…` — issued by your org admin. **Server-side only:** it authenticates your whole organization, not one end user. |
| `ZOOCLAW_AGENT_ID` | `agt_…` — copy it from your agent's detail dialog in the workspace UI. |

## Templates

| Template | What it is | Needs |
|---|---|---|
| [`chat/`](chat/) | **Start here.** The smallest thing that talks to your agent: a chat box, one conversation, ~250 lines, no database and no build step. Two values and two commands. | Node 20 |
| [`app-kit/`](app-kit/) | **Production reference.** Cloudflare Workers + D1 + Durable Objects + Access: per-user agents, multi-conversation, refresh-safe streaming, a `domain/` seam for verticals. Go here when `chat/` runs out of room. | Node 22, pnpm, wrangler |

## Your coding assistant already knows this platform

This repo vendors the ZooClaw platform skill at
[`.agents/skills/zooclaw-managed-agents/`](.agents/skills/zooclaw-managed-agents/). Clone
the repo, open your assistant in it, and it knows the API shape before it writes a line:
which calls exist, which do not, and the handful of places where code that looks right
fails at runtime.

Nothing to install. If you want the same skill in projects outside this repo:

```bash
/plugin marketplace add SerendipityOneInc/zoowork-sdk-skills
```

## Adding a template

One directory, self-contained, no workspace linking — each template has its own
`package.json` and installs independently.

```
<name>/
├── README.md          what it is, what to fill in, how to run — in that order
├── .env.example       the values to fill in, and where to copy them from
├── skill.md           this template's own gotchas, written for a coding assistant
└── …                  the app
```

Then add a row to the table above.

## Links

- **SDK** — [`@zooclaw-agents/sdk`](https://www.npmjs.com/package/@zooclaw-agents/sdk)
  ([source](https://github.com/SerendipityOneInc/zoowork-sdk-typescript))
- **API reference** — [zoowork-agents-docs](https://github.com/SerendipityOneInc/zoowork-agents-docs)
- **Skills** — [zoowork-sdk-skills](https://github.com/SerendipityOneInc/zoowork-sdk-skills)

## License

MIT. See [LICENSE](LICENSE).
