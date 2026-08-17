# skill-lab

> A template in [ZooClaw Quickstarts](../README.md). Build an agent, then teach it something.

Ask an agent something it cannot know. Install a skill you wrote. Ask the exact same
thing again. The difference between the two answers is what a skill *is*.

## Run it

```bash
cd skill-lab              # every command below runs in this directory
cp .env.example .env      # paste your ZOOCLAW_API_KEY
npm install
npm run dev               # http://localhost:3000
```

Needs **Node 22.20 or later** — the floor across this repo, set by the `skills` CLI. `npm`
ships with Node; `pnpm install` / `pnpm dev` work too if you have it.

Port 3000 busy, or running `chat` at the same time? `PORT=3001 npm run dev`.

One value this time — no agent id. **This template builds its own agent** on first run
and remembers it in `.agent`, so restarting does not litter your org. Point it at an agent
you already own with `ZOOCLAW_AGENT_ID` if you prefer.

## The five-minute demo

1. Ask **"咖啡多少钱？菜单上有什么？"** — the agent invents plausible market prices.
2. Click **Install** on `coffee-order` in the left panel.
3. Click **Ask again**.

The second answer is your menu, to the yuan, including the two details that exist nowhere
but in [`skills/coffee-order/SKILL.md`](skills/coffee-order/SKILL.md): oat milk is free,
and the bar closes at 16:00.

Every question opens a **fresh session**, so the second answer comes from the skill rather
than from the agent remembering what it just said.

## Write your own

Make a folder under `skills/`, put a `SKILL.md` in it, reload the page:

```
skills/
└── your-skill/
    └── SKILL.md
```

```markdown
---
name: your-skill
description: Use whenever the user asks about X, mentions Y, or wants to do Z.
---

# Your skill

Whatever the agent should know or do.
```

> **Everyone in one organization shares one skill namespace.** Skills upload at `org` scope and
> are matched by **name**. If a colleague uploads a different `coffee-order`, it becomes a new
> *version* of the same skill and your agent follows it. In a workshop or a shared org, prefix
> your skill name with something of your own — `lily-pricing`, not `pricing`.
>
> Uninstalling only detaches the skill from your agent; it stays in the org registry, so nobody
> else loses it.

**The `description` is the only part the agent reads when deciding whether your skill is
relevant.** The body is loaded afterwards, and only if the description won. A description
that says what the skill *is* ("notes about our coffee bar") rather than *when to use it*
("whenever the user asks about coffee prices or the menu") will simply never fire — the
body can be perfect and it will never be read. This is the single most common way a
first skill fails, so the panel shows each description next to its skill.

## What you can and cannot change

| | |
|---|---|
| **Persona** | Yours. Edit it in the panel; it applies to the next question. |
| **Your skills** | Yours. Upload, install, uninstall. Re-installing the same name publishes a new **version** — agents follow it automatically. |
| **Built-in skills** | Not yours. The 18 in the bottom panel were attached when the agent was created. They cannot be added, removed, or chosen — `putAgentSkill` on a built-in returns 404. |

That last row is the shape of the platform: you do not pick capabilities from a catalog,
because you already have the catalog. What you add is what only you know.

## Files

| | |
|---|---|
| [`server.mjs`](server.mjs) | the whole backend — create, configure, upload, install, ask |
| [`web/index.html`](web/index.html) | the whole frontend |
| [`skills/`](skills/) | your skills, one folder each |
| [`zip.mjs`](zip.mjs) | uninteresting plumbing: `uploadSkill()` wants a zip |
| [`skill.md`](skill.md) | the gotchas, written for a coding assistant |

## Change it

Teach your assistant the platform first — one command, and it works for Claude Code, Codex,
Cursor and 70-odd others:

```bash
npx skills add SerendipityOneInc/zoowork-sdk-skills
```

Then open your assistant here and ask. `skill.md` covers what is specific to this template.

## Next

[`chat/`](../chat/) is smaller — two values and a chat box, no agent building.
[`app-kit/`](../app-kit/) is bigger — auth, persistence, multi-user agents.
