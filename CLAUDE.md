## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows.
Install it for the best experience:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Skills like /qa, /ship, /review, /investigate, and /browse become available after install.
Use /browse for all web browsing. Use ~/.claude/skills/gstack/... for gstack file paths.

## zstack (this repo)

The section above is about *using* gstack from inside a project. This one is
for an agent working *on* zstack itself — the pack in this repo.

**What it is.** An installable Claude Code skill pack that runs the Develop
and Merge stages of a dev loop unattended: `/z-setup` provisions a GitHub
ProjectV2 board, `/z-plan` turns a spec into grounded tickets, `/z-loop`
drains the Ready queue through fresh-agent builder → QA → adversarial-review →
merge lanes, `/z-status` reports, `/z-update`/`/z-uninstall` handle the
install lifecycle. Each skill is one directory (`SKILL.md` + `bin/` shim +
`lib/*.ts`), the same layout gstack uses.

**Deterministic core decides, agents execute.** Every scheduling, transition,
merge-order, and cost decision is computed by bun TypeScript under `lib/`
(`lib/loop.ts`, `lib/lanes.ts`, `lib/board.ts`, …) — never reasoned out in an
agent's prose. `lib/board.ts` is the sole `gh` caller in the whole pack (gate
tests grep for stray direct `gh` calls); agents only do the latent work:
writing code, judging QA/review results. Full statement:
`docs/user-guide/spec/PRINCIPLES.md`, `docs/user-guide/spec/PROCESS.md`.

**Two test lanes, different budgets.** `tests/` are deterministic gate tests —
free, no LLM calls, each file expected to finish in seconds — run with
`bun test`; a source-string/grep-based test (like the `gh`-caller check above)
pins a past regression so it can never silently reappear. `evals/` are the
paid, periodic quality lanes (`evals/planner/` grades `/z-plan` output,
`evals/e2e/` proves a full loop against a fixture) — every LLM call in an eval
goes through local Claude Code (`claude -p`), never a hosted API.

**Before calling anything done:** `bun test && bun run typecheck` (the latter
is `tsc --noEmit`) must both be green — this is also the pre-merge/health-check
command in the Deploy Configuration below.

## Deploy Configuration (configured by /setup-deploy)

- Platform: none (skill pack — installed to ~/.claude/skills/zstack, not hosted)
- Production URL: none
- Deploy workflow: merge PR to main; users install/update the pack from main
- Deploy status command: none
- Merge method: squash
- Project type: CLI / skill pack
- Post-deploy health check: `bun test && bun run typecheck` on main

### Custom deploy hooks

- Pre-merge: `bun test && bun run typecheck`
- Deploy trigger: merge to main (no push-triggered deploy)
- Deploy status: none
- Health check: `bun test && bun run typecheck`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
