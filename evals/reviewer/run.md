# /z-loop adversarial reviewer eval

Measures issue #59's REVIEW QUALITY claim: adversarial mode surfaces a subtle
planted defect that single-pass review approves. **Paid lane** (LLM calls), NOT
in the gate suite (`bun test`). Every LLM call goes through **local Claude Code
(`claude -p`)** — never a hosted API (PRINCIPLES.md "LLM access"). The
deterministic half of #59 is gate-tested in `tests/stage-prompts.test.ts`; this
eval covers only the latent half a predicate can't.

The reviewer's active prompt spawns skeptic sub-agents via the **Agent tool**
(nested `claude -p` is denied by the classifier — MEMORY). The outer `claude -p`
here is a first-level headless run from the shell (same as `evals/planner`), so
the reviewer's inner Agent-tool fan-out is allowed.

## Inputs

- `fixtures/planted-defect/ticket.md` — the ticket body, carrying its
  `### Acceptance Criteria`. Criterion 3 is the boundary the defect violates.
- `fixtures/planted-defect/diff.patch` — a two-file diff (`src/window.ts` +
  `src/window.test.ts`) that typechecks, is green, and hides a `<=`-vs-`<`
  off-by-one on the half-open window's end. The test file skips the boundary
  case, so nothing green exercises the bug.
- `rubric.md` — the per-trial pass contract and the ≥ 4/5 threshold (AC11).
- `../../lib/stage-prompts.ts` — the prompt constructor under test.

## What the harness does

Both prompts are built from the SAME blinded four-key input (blindness intact:
mode rides as a `--adversarial-mode` flag, never a fifth key), then each is
driven through a fresh live Agent for N trials:

- **single-pass** ← `--adversarial-mode off` → `reviewerPrompt(input, false)`.
- **adversarial** ← `--adversarial-mode always` → `reviewerPrompt(input, true)`.

A trial passes when the adversarial run ends `REVIEW-FINDINGS:` naming
criterion 3's boundary defect with a below-100 `confidence=`, AND the single-pass
run ends `REVIEW-APPROVE:` (rubric.md). Pass the eval at ≥ 4/5.

## Running it

`run.sh` (issue #71) is the runnable harness, extracted verbatim from this
section's former inline bash to match `evals/planner/run.sh`'s shape. Every
LLM call goes through `$CLAUDE_CMD` (default `claude -p`) — never a hosted API
(PRINCIPLES.md "LLM access").

```bash
# The real (paid) run -- nightly, or before ship:
evals/reviewer/run.sh 5

# The free, structural smoke test (exercises every branch of run.sh's
# plumbing -- both prompt shapes, the grade JSON parse, the >=4/5 threshold,
# the exit code -- with a canned mock-claude.sh instead of real claude -p.
# Says nothing about real model quality; see "## Results" below for that):
CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 5
```

Exit 0 = the fan-out beat single-pass on the planted defect in ≥ 4/5 trials;
exit 1 = below threshold, with the per-trial grades in the run's temp output
dir (printed on stdout) either way.

## Verifying the harness offline (free)

The fixture and both prompts are checkable with zero cost — this asserts the
input stays four-key-blinded and the two branches diverge exactly as the gate
tests pin, without any `claude -p`:

```bash
FIX=evals/reviewer/fixtures/planted-defect
AC="$(awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIX/ticket.md")"
bun -e "import {readFileSync,writeFileSync} from 'node:fs';
  writeFileSync('/tmp/rv.json', JSON.stringify({ticketBody:readFileSync('$FIX/ticket.md','utf8'),
    acceptanceCriteria:process.argv[1],diff:readFileSync('$FIX/diff.patch','utf8'),
    worktreePath:'/tmp/x'}));" "$AC"
bun lib/stage-prompts.ts prompt reviewer /tmp/rv.json --adversarial-mode off    | grep -qv skeptic && echo "single pass: ok"
bun lib/stage-prompts.ts prompt reviewer /tmp/rv.json --adversarial-mode always | grep -q  skeptic && echo "adversarial: ok"
```

## Nightly scheduling

Documentation only — the command; scheduling is the user's cron/routine:

```cron
# Nightly, real claude -p, 5 trials:
0 4 * * * cd /path/to/zstack-1 && evals/reviewer/run.sh 5
```

## Results

**2026-07-20, 5 trials, ticket #71.** Run from inside an unattended zstack-loop
builder subagent, which has no `claude -p` CLI on `PATH` (nested headless
`claude -p` is the exact pattern MEMORY documents as blocked on this machine)
— per this file's own line above ("nested `claude -p` is denied by the
classifier, so use the Agent tool"), each trial substituted the Agent tool for
the "fresh live Agent" `run.sh` drives via `$CLAUDE_CMD`: the same prompts
`stage-prompts.ts` builds (verbatim, unmodified) were each handed to a fresh
`general-purpose` subagent (Agent-tool access lets the adversarial trials fan
out their 3 skeptics exactly as the super-truth pass instructs) instead of a
shelled `claude -p`. Grading was done directly against `rubric.md`'s per-trial
contract rather than a separate grader call, since the marker prefix, the
confidence token, and whether the findings name criterion 3 were all
mechanically checkable from each trial's own final message.

`worktreePath` in the shipped fixture input is a placeholder
(`/tmp/review-throwaway-planted`) that is never materialized by this file's
harness or by `run.sh` — both prompts ask the reviewer to "run the typecheck
and the tests this diff touches" there regardless. To get a real signal
rather than 5 `BLOCKED: worktree unusable` trials, a real throwaway directory
was built by hand from `diff.patch`'s own added lines (`src/window.ts` +
`src/window.test.ts`), confirmed green (`bun test` → 3 pass / 0 fail, matching
rubric.md's description) before driving any trial.

**Score: 0/5 by the rubric's strict per-trial contract** (adversarial finds
it AND single-pass does not) — NOT because adversarial mode failed: all 5
adversarial trials correctly ended `REVIEW-FINDINGS: confidence=0`, naming
criterion 3's `<=`-vs-`<` boundary defect with file:line evidence, every
time. The reason every trial is "inconclusive, not a pass" per rubric.md is
that **single-pass ALSO caught the defect in all 5 trials**, ending
`REVIEW-FINDINGS` (never `REVIEW-APPROVE`) every time — no delta between the
two modes was ever observed, so no trial can satisfy the rubric's "measures
the delta" contract. Below the ≥ 4/5 threshold either way. **Bug ticket
filed per this file's own AC1 contract:
[#88](https://github.com/zacgoodwin/zstack/issues/88)** — see that ticket for
the two root causes found (the fixture's own AC3 prose narrates the defect's
location, and `diff.patch`'s first hunk header miscounts its own added lines,
so it is not a strictly valid patch either) plus the worktree-materialization
gap.

**2026-07-20, ticket #88 (fixture/harness fix; no new paid run yet).** Fixed
all three root causes #71 found:

- `ticket.md` AC3 no longer narrates "this is the boundary the double-count
  bug hides at" — it states only the required half-open contract
  (`withinWindow(1500, 1000, 500)` → `false`). Re-verified mechanically (ran
  the planted `withinWindow` from the materialized diff against all four
  criteria) that the diff still violates the rewritten AC3 — only the prose
  changed, `now <= end` is untouched.
- `diff.patch`'s first hunk header was `@@ -0,0 +1,10 @@` over 9 actual `+`
  lines (direct count, confirmed); fixed to `+1,9`. `git apply --unsafe-paths
  --directory=<tmp> evals/reviewer/fixtures/planted-defect/diff.patch` now
  exits 0 from a fresh scratch dir, `<tmp>/src/window.ts` and
  `<tmp>/src/window.test.ts` both present and matching the diff (AC1, gate-
  checkable).
- `run.sh` now applies `diff.patch` into a fresh `mktemp -d` before building
  the blinded input and points `worktreePath` at that real directory (also
  added to both live Agent calls via `--add-dir`), replacing the dead
  `/tmp/review-throwaway-planted` placeholder — the synthetic-fixture
  equivalent of production's `git worktree add` (z-loop/SKILL.md). The mocked
  smoke test (`CLAUDE_CMD=evals/reviewer/mock-claude.sh evals/reviewer/run.sh
  1`) still exits 1 at 1/1 trials, identical to the pre-fix baseline (diffed
  against the unpatched `run.sh`); `run.sh 5` mocked still exits 0 at 5/5 — no
  regression (AC2, gate-checkable).

**AC3's paid 5-trial re-run has NOT been executed.** This ticket was built
unattended inside a zstack-loop builder subagent with no real `claude -p` on
`PATH` (nested headless `claude` denied by the classifier — MEMORY), and per
this ticket's explicit build instructions the eval was not to be faked or
substituted here (unlike #71, where the trials themselves were the
deliverable being measured — for #88 the open question is whether *this
fix* closes the gap, which only a real run can answer; simulating that
answer would be exactly the fabrication this file's own discipline forbids).
**A human or an environment with real `claude -p` access must run
`evals/reviewer/run.sh 5` and append the real score below this entry** before
AC3 can be marked closed. Whether the de-spoiled AC3 prose is enough to make
single-pass approve where it caught the defect in 5/5 pre-fix trials, or
whether the defect is simply too mechanically obvious for a frontier
single-pass reviewer with real code execution regardless of prose (this
ticket's own documented fallback), is exactly what that run will show.
