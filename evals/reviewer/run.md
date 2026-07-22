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

**Exit 2 = HARNESS ERROR**, a distinct outcome from a low score: at least one
grade file could not be read, so no measurement was taken. The reason for each
unreadable grade is printed. Do not record an exit-2 run in "## Results" — rerun
it. This exists because the grader is a live model writing free-form text, and
`run.sh` used to parse it inline with a bare `JSON.parse`: a ```` ```json ````
fence (which the grader emits more often than not) threw, and the trial scored
FAIL regardless of the verdict. `evals/lib/grade.ts` now owns the extraction and
tells "graded FAIL" apart from "unreadable" (#108).

On a Windows/Git-Bash box, note `/tmp` is `%LOCALAPPDATA%\Temp` — the printed
artifact path resolves there, not to a literal `C:\tmp`.

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

**2026-07-20, 5 trials, ticket #102 (real paid run, AC3 of #88).** Ran
`evals/reviewer/run.sh 5` (real `claude -p`, `CLAUDE_CMD` not overridden to
`mock-claude.sh`) against the post-#88 fixture. All 5 trials completed with a
graded score and no harness or materialization error. Headline, `run.sh`'s
own output: "adversarial surfaced the defect in 0/5 trials (pass threshold:
4/5)" followed by "FAIL: below threshold" (exit 1).

**Score: 0/5.** Per-trial grades (`grade-1.json` .. `grade-5.json`) are
identical in shape across all 5 trials:

```json
{
  "adversarialMarker": "REVIEW-FINDINGS",
  "singlePassMarker": "REVIEW-FINDINGS",
  "namesDefect": true,
  "adversarialConfidence": 0,
  "pass": false
}
```

**Single-pass-vs-adversarial delta: none — single-pass also caught it.**
Adversarial mode worked exactly as designed in all 5 trials —
`REVIEW-FINDINGS: confidence=0`, 3/3 skeptics refuting, naming criterion 3's
`<=`-vs-`<` boundary defect with file:line evidence and an executed
counter-example (`withinWindow(1500,1000,500)` returns `true`, must be
`false`). But per `rubric.md`'s per-trial contract, a trial only passes when
adversarial catches the defect AND single-pass does not — and single-pass
ALSO ended `REVIEW-FINDINGS` (never `REVIEW-APPROVE`) in all 5 trials,
independently reproducing the same file:line, the same executed
counter-example, and the same fix (e.g. single-1: "AC3 fails: the boundary
is inclusive, not exclusive... Fix is `now < end`."). No trial shows the
delta the fan-out is meant to buy, because there is none to show here.

**Interpretation (AC3): the fixture does not discriminate.** Not a harness
defect — #88's AC1/AC2 fixes hold, and all 5 trials completed cleanly
against a real materialized worktree. Not an adversarial-mode failure —
adversarial named the defect correctly, with below-100 confidence, every
single time. The planted `<=`-vs-`<` boundary defect is too mechanically
obvious for a frontier single-pass reviewer with real code execution to
miss, regardless of #88's de-spoiled AC3 prose: the reviewer runs the
function against the stated acceptance criteria and the boundary case
fails, full stop. The ≥4/5 threshold is unchanged and was NOT weakened to
force a pass. **Follow-up filed:
[#108](https://github.com/zacgoodwin/zstack/issues/108)** — design a
subtler planted defect for this fixture, so the eval can actually
discriminate adversarial from single-pass review quality.

**2026-07-22, ticket #108 (fixture redesigned twice; paid 5-trial score still
pending).** The fixture was redesigned, then redesigned AGAIN after one real
paid trial disproved the first design. The paid 5-trial score could not be
recorded from this unattended builder lane; the exact command a human must
run is at the end of this entry.

**Round 1 (disproven by a real trial).** Salvaged from the prior #108
attempt (dangling commit c5d70a8): `windowStartFor(now, d)` computed
`(Math.ceil(now / d) - 1) * d` — equal to the correct
`Math.floor(now / d) * d` everywhere except exact multiples of `d`, one
window early there — and criterion 3 stated the universal invariant
`withinWindow(now, windowStartFor(now, d), d) === true`. One real paid trial
killed it: the single-pass reviewer executed the stated invariant as a
property check in the throwaway worktree and caught the defect immediately.
Its transcript opens "Confirmed a real defect. Running the AC3 property
myself in the throwaway worktree." and names the exact mechanism ("on every
boundary tick `ceil(now/d) === now/d`, so it subtracts a whole step and
returns the **previous** window's start"). The lesson, now twice-confirmed
(#102's printed failing example, this round's stated invariant): **a
code-executing single-pass reviewer runs every acceptance criterion that is
stated executably** — a literal failing example or a universal property is
caught every time, no matter how the defective expression is camouflaged.

**Round 2 (shipped).** The defect moved to where executing the stated
criteria cannot reach: a stateful interaction between two code paths.
`src/window.ts` now ships `windowStartFor` and `withinWindow` both fully
CORRECT — their half-open boundary semantics are pinned by criterion 3's
(passing) examples and visibly tested, exact-boundary cases included — plus
the ticket's real deliverable, `FixedWindowLimiter.allow(now)`. The planted
defect is `allow()`'s inlined window-currency check
`now - this.windowStart <= this.durationMs` ("still inside the open
window"), where the half-open contract requires `<`. It is literally the
`<=`-vs-`<` end check `rubric.md`'s grading contract names, in
`src/window.ts` — but it sits in a code path no criterion states executably,
and it only misbehaves when an EXHAUSTED window meets a request landing
EXACTLY on the boundary tick:

- wrongful reject: `limit 2` — `allow(1400)` T, `allow(1450)` T, then
  `allow(1500)` → `false` (judged against the full old window) where
  criterion 3 requires `true` (1500 opens a fresh window);
- limit slip: `allow(1400)` T, `allow(1500)` T (silently charged to the OLD
  window), `allow(1600)` T, `allow(1700)` T — three admits land in the
  window `[1500, 2000)` against `limit 2`.

Proven mechanically before shipping: the defective code is green on all 13
shipped tests and every literal AC example; the one-character fix (`<=` →
`<`) flips both killer sequences above and stays green on all 13 tests. The
shipped test file even carries a boundary-NAMED test ("a request landing on
a window boundary is admitted": 1400 then 1500, budget to spare) that passes
on the defective code — surfacing the defect requires CONSTRUCTING the
full-window × boundary-tick sequence or tracing the inline check against the
helpers' algebra, which no literal read of the criteria builds (#108 AC1).
The mock structural smoke
(`CLAUDE_CMD=evals/reviewer/mock-claude.sh evals/reviewer/run.sh 5`) exits 0
on the new fixture, and exits 1 with `MOCK_CLAUDE_PASS=false` — plumbing and
threshold both exercised.

**Why the paid score is pending.** Two full `run.sh 5` runs were started and
had to be killed: this builder's harness can not carry a ~30-60 minute run
to completion (background children are untracked and never re-invoke the
agent; a foreground call is capped at 10 minutes, and one adversarial trial
with its 3-skeptic fan-out can exceed that alone). The one trial that DID
complete (round 1's single-pass, quoted above) is folded in as evidence. To
record the score, run on any normal shell and append the result here:

```bash
evals/reviewer/run.sh 5
```

Two notes for the runner: (1) if the shell exports `FORCE_COLOR` (this
builder harness does), run `env -u FORCE_COLOR evals/reviewer/run.sh 5` —
bun's forced-color `console.log` otherwise breaks run.sh's per-trial
pass-count string compare and silently scores 0; (2) `run.sh`, `rubric.md`,
and the ≥4/5 threshold are untouched per #108 AC3. rubric.md's
"## The planted defect" description substantively matches the shipped defect
(a `<=`-vs-`<` end check in `src/window.ts` violating criterion 3's
half-open boundary, untested by the shipped suite); one stale parenthetical
(`withinWindow(1500, 1000, 500)` — that helper is now correct) survives from
the old fixture, and the grading contract's "or the untested boundary case"
disjunct covers the shipped defect regardless.

