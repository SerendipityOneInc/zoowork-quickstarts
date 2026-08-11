# Working on the `skill-lab` quickstart

What is not obvious about configuring a ZooClaw agent. Every claim was verified against a
live deployment on 2026-08-11.

---

## The two things you can change, and the one you cannot

An agent's capability comes from **skills**, not from a client-declared tool list. On a
fresh agent, `declared.tools` is `null` and `declared.tool_policy` is `{}` — yet the agent
can search the web, write documents and generate images, because the platform attached 18
`global` skills when it was created.

| | |
|---|---|
| `persona` | writable via `updateAgent`, and it takes effect on the next turn — verified |
| `tool_policy` | writable, round-trips (`{allow:['web_search']}`) |
| your own skills | uploadable and installable — verified end to end |
| **`global` skills** | **`putAgentSkill` returns 404.** They cannot be added, removed or chosen. |

So there is no "pick your capabilities" flow to build, and its absence is not a gap:
`listSkills()` returns 21 skills, all `global`, and a new agent already carries 18 of
them. What a user adds is what only they know.

---

## Uploading a skill

`uploadSkill(zip, { scope: 'org' | 'personal' })`. Notes that cost time:

- **It wants a zip**, not a file or a directory. `zip.mjs` here writes one with STORED
  (uncompressed) entries so the template keeps a single dependency.
- **The zip's top-level directory must match the frontmatter `name`.** `coffee-order/SKILL.md`
  declaring `name: coffee-order`. A mismatch is rejected with a message naming both. A zip
  whose root *is* the skill (SKILL.md at top level) is also accepted.
- **`scope` may only be `org` or `personal`.** `global` and `pack` are 403 — those are
  published through a different path.
- **Re-uploading the same name is a new version, not a new skill.** Use
  `uploadSkillVersion(skillId, zip)`. Agents that installed it unpinned follow the new
  version by themselves; the registry bumps their `config_version` and you do **not**
  call `putAgentSkill` again.
- **`deleteSkill` has no in-use guard.** Agents holding the skill just lose it.

---

## The description is the trigger, the body is the payload

This one bites hard because the failure is silent and looks like the platform is broken.

A skill's frontmatter `description` is what the agent sees when deciding whether the skill
is relevant. The body is loaded **only after** the description wins. A first attempt here
put the trigger word in the body and a description that merely said what the skill was —
the skill installed correctly, showed as `eligible: true`, and never fired. Rewriting the
description to say *when to use it* made it work on the first try.

```yaml
# never fires
description: A skill containing our coffee bar information.

# fires
description: Use whenever the user asks about the office coffee menu, coffee prices,
  or wants to order a coffee — including the words latte, espresso, or americano.
```

When debugging "my skill does nothing", check the description before anything else.

---

## Verifying a skill actually ran

`listAgentSkills(agentId)` tells you it is **attached**, not that it **ran**. An attached
skill row looks like this, and every field here is a real one:

```json
{ "skill_id": "skl_…", "name": "coffee-order", "scope": "org", "version": "1",
  "eligible": true, "location": "/skills/coffee-order/SKILL.md",
  "basePath": "/opt/zooclaw/skills/org/coffee-order/1" }
```

`eligible: true` and a `basePath` mean it is installed and on disk. Whether the model
loaded it is only observable in the answer. Put something in the skill that the model
could not otherwise produce — an exact price, an internal name — and check for it.

---

## Sessions, when you are comparing

**Open a fresh session for every question you intend to compare.** In one session the
agent remembers its previous answer, so a "before / after installing the skill" comparison
reads its memory rather than its skills. This template creates a session per question for
exactly that reason.

---

## Creating and configuring an agent

- **`ownership` is required by the schema and overwritten by the gateway.** Send
  placeholders; do not go looking for your real uid and org id.
- **The gateway seeds model credentials for you after creation.** Each write bumps
  `config_version`, so a create receipt saying `1` reads back as `3` a second later.
  Never treat the create-time version as current.
- **A new agent is `stopped`.** Call `startAgent()` and poll `status.desired_state`.
  `actual_state` tracks chat-channel connectivity, has no `running` member, and parks at
  `activating` forever for an API-only agent — a loop waiting on it never returns.
- **`startAgent` warns `channel_routes_reload_failed`.** Expected and harmless.
- **`updateAgent` merges by section.** Sending `persona` replaces the whole persona
  section and leaves `model`, `labels` and `tool_policy` alone. Every call bumps
  `config_version`, so gate writes on an actual change if you are calling it often.
- **`deleteAgent` is a soft delete and does not stop the agent.** Stop first, then delete,
  or you leave a running sandbox behind.

---

## Untested here

- `personal` scope (only `org` was exercised).
- Pinning a skill to a version (`putAgentSkill(…, { versionPin })`).
- Whether `tool_policy` actually restricts anything — it round-trips, but the built-in
  tool names are not enumerable through any route, so there is nothing to assert against.
