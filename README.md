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
| [`chat/`](chat/) | **Start here.** The smallest thing that talks to your agent: a chat box, one conversation, ~250 lines, no database and no build step. Two values and two commands. | Node 22.20 |
| [`skill-lab/`](skill-lab/) | **Teach an agent something.** Builds its own agent, then lets you edit its persona and upload skills you wrote — and ask the same question before and after, to see what changed. Needs only the key. | Node 22.20 |
| [`app-kit/`](app-kit/) | **Production reference.** Cloudflare Workers + D1 + Durable Objects + Access: per-user agents, multi-conversation, refresh-safe streaming, a `domain/` seam for verticals. Go here when `chat/` runs out of room. | Node 22.20, pnpm, wrangler |

## Teach your coding assistant this platform

One command, before you start:

```bash
npx skills add SerendipityOneInc/zoowork-sdk-skills
```

Your assistant then knows the API shape before it writes a line: which calls exist, which do
not, and the handful of places where code that looks right fails at runtime.

This installs into whichever assistants you have — Claude Code, Codex, Cursor and 70-odd
others — each in the directory it actually reads. Add `-g` to install for every project
instead of this one. Using Claude Code only? `/plugin marketplace add
SerendipityOneInc/zoowork-sdk-skills` does the same thing.

Install it wherever you are building, not just here: the skill is about the platform, and
that is most useful in *your* project.

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
