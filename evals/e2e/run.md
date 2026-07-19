# /z-loop end-to-end eval — operator procedure

The full-loop eval. It instantiates the fixture app into a throwaway git repo,
runs the whole pack against it (`/z-setup` → `/z-plan` → `/z-loop`) with deploy
stubbed, and then runs `check.ts` over the artifacts to prove the epic's
Definition of Done end to end.

This is the **paid, periodic lane** (LLM calls) — NOT part of `bun test`. Every
LLM call goes through **local Claude Code (`claude -p`)**, never a hosted API
(PRINCIPLES.md "LLM access"). The gate-testable half is `check.ts`, which runs in
`bun test` against `fixtures/sample-run/` (see `../../tests/e2e-check.test.ts`).

## Pass threshold

The run passes when **`check.ts` exits 0**: all ten assertions green against the
run's artifact directory. There is no partial credit — the loop either drove the
board through the full lifecycle correctly or it did not. `check.ts` is
deterministic, so unlike the graded planner eval there is no averaging; one green
run is the bar. Run it before ship and nightly.

## Prerequisites

- gstack + bun + gh installed, `./setup` run (see the root `README.md`).
- A GitHub repo you can create a throwaway ProjectV2 board under, with
  `gh auth refresh -s project` done (the loop needs the `project` scope — this is
  the caveat below).

## The caveat: `/z-setup`'s board is live-only

`/z-setup` creates a real GitHub ProjectV2 board and (Step 4) requires a human to
toggle two workflow rules off in the web UI — GitHub exposes no API for them. So
the board half of this eval cannot be fully headless. Two modes:

- **Live mode** (full DoD coverage): do `/z-setup` for real against a scratch
  repo, then run the loop against the live board. This is the only way to exercise
  the board-contract DoD items (see the traceability table in `README.md`).
- **Fixture mode** (deterministic, CI-friendly): skip the live board; run
  `check.ts` against `fixtures/sample-run/`, the hand-authored artifact set that
  represents one successful live run. This is what the gate test drives.

## Procedure (live mode)

1. **Instantiate the fixture into a temp repo.**

   ```bash
   REPO="$(mktemp -d)/fixture-app"
   mkdir -p "$REPO"
   cp -r evals/fixture-app/. "$REPO/"
   cd "$REPO"
   git init -q && git add -A && git commit -qm "fixture-app baseline"
   bun install            # brings in typescript + bun-types for `bun run typecheck`
   bun test               # baseline suite is green before the loop starts
   gh repo create <you>/zstack-e2e-fixture --private --source=. --push
   ```

2. **`/z-setup`.** Run the skill against the temp repo. Create the board, the
   nine statuses, the four fields; toggle auto-archive and issue-auto-close OFF
   (Step 4); wire deploy to the fixture's stub (`bun run deploy`, which echoes and
   exits 0 — nothing ships).

3. **`/z-plan` on the fixture spec.**

   ```bash
   claude -p "/z-plan $OLDPWD/evals/e2e/fixture-spec.md"
   ```

   Expect three tickets in a dependency chain (response helper ← `/health` ←
   `/metrics`), each fielded and estimated, the dependents linked and pulled into
   Ready. (For the offline planner-only check, use the dry-run harness in
   `../planner/run.md` — that is the standalone planner lane.)

4. **`/z-loop`.** Run the loop. It plans, batch-commits Ready → Building, drives
   each ticket through builder → QA → reviewer → merge in dependency order, then
   runs the end-of-loop stage: regression on merged main, and — because the
   fixture is green — the deploy chain against the stub (`/land-and-deploy` →
   `/canary` → `/document-release`), writing a report and bumping the loop
   counter. Stage skill invocations are dry-run: the fixture's deploy stub means
   `/land-and-deploy` touches no real environment.

5. **Collect the artifacts + check.** Point `check.ts` at the run's state dir:

   ```bash
   bun evals/e2e/check.ts ~/.zstack/projects/zstack-e2e-fixture
   ```

   A live run's directory must expose the same artifact names the checker reads
   (see `README.md` → "Artifacts the checker reads"). Exit 0 = pass.

## Procedure (fixture mode)

```bash
bun evals/e2e/check.ts        # defaults to fixtures/sample-run/
echo "exit: $?"               # 0 = pass
```

This is what `bun test` runs via `tests/e2e-check.test.ts`, plus mutated copies
that prove each assertion actually catches its break.
