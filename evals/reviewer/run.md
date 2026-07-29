# /z-loop adversarial reviewer eval

Measures issue #59's REVIEW QUALITY claim. **Paid lane** (LLM calls), NOT in the
gate suite (`bun test`). Every LLM call goes through **local Claude Code
(`claude -p`)** — never a hosted API (PRINCIPLES.md "LLM access"). The
deterministic half of #59 is gate-tested in `tests/stage-prompts.test.ts` and
this eval's scoring in `tests/reviewer-recall.test.ts`; the paid lane covers
only the latent half a predicate can't.

**What it asks:** how much of what is wrong does one review cycle surface? Both
modes review the same diff, which carries eight independent planted defects, and
a trial passes when the adversarial fan-out names strictly more of them than the
single pass. It used to ask something narrower — does adversarial catch one
needle single-pass approves — and that contract was abandoned after four fixture
redesigns and 16 real single-pass reads showed it cannot be satisfied. The
evidence is in "## Results" below and the reasoning in `rubric.md`.

The reviewer's active prompt spawns skeptic sub-agents via the **Agent tool**
(nested `claude -p` is denied by the classifier — MEMORY). The outer `claude -p`
here is a first-level headless run from the shell (same as `evals/planner`), so
the reviewer's inner Agent-tool fan-out is allowed.

## Inputs

- `fixtures/multi-defect/ticket.md` — the ticket body, carrying its 12
  `### Acceptance Criteria`.
- `fixtures/multi-defect/diff.patch` — a 771-line, four-file diff (a keyed rate
  limiter plus its HTTP middleware) that typechecks and is green on all 55 of
  its own tests while hiding eight independent defects, four of them stateful
  interactions between individually-correct paths (the class the first paid run
  showed carries the delta — rubric.md has the table).
- `fixtures/multi-defect/defects.json` — the answer key: each defect's site,
  mechanism, the criterion it violates, and a reproduction. **Never part of the
  reviewer's input**; only the grader reads it.
- `rubric.md` — the per-trial pass rule and the ≥ 4/5 threshold (AC11).
- `../lib/recall.ts` — the deterministic scorer.
- `../../lib/stage-prompts.ts` — the prompt constructor under test.

## What the harness does

Both prompts are built from the SAME blinded four-key input (blindness intact:
mode rides as a `--adversarial-mode` flag, never a fifth key), then each is
driven through a fresh live Agent for N trials:

- **single-pass** ← `--adversarial-mode off` → `reviewerPrompt(input, false)`.
- **adversarial** ← `--adversarial-mode always` → `reviewerPrompt(input, true)`.

A fresh local grader then does the only latent job in the eval: for each defect
id, did that output actually name it (same site, same mechanism)? Everything
after that is code — `evals/lib/recall.ts` counts, aggregates and thresholds, so
no number in the report is read out of a model's prose.

A trial passes when adversarial names **strictly more** planted defects than
single-pass. A tie is not a pass. Pass the eval at ≥ 4/5 trials, or
`ceil(0.8 × N)` for a run of N.

## Running it

```bash
# The real (paid) run -- nightly, or before ship:
evals/reviewer/run.sh 5

# The free, structural smoke test (exercises every branch of run.sh's
# plumbing -- both prompt shapes, the per-defect grade parse, recall.ts's
# threshold, the exit code -- with a canned mock-claude.sh instead of real
# claude -p. Says nothing about real model quality; see "## Results" for that):
CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 5
```

Exit 0 = the fan-out beat single-pass on breadth in ≥ 4/5 trials; exit 1 = below
threshold, with the per-defect catch table and both mean recalls printed either
way.

**Exit 2 = HARNESS ERROR**, a distinct outcome from a low score: at least one
grade could not be read, so no measurement was taken. Every unreadable grade is
named with its reason. Do not record an exit-2 run in "## Results" — rerun it.
`recall.ts` treats a missing defect id or a non-boolean verdict as unreadable
rather than as a miss, because scoring drift as "not found" would understate
recall and turn a harness fault into a measurement. This is the #108 failure
mode one level up: `run.sh` used to parse the grade inline with a bare
`JSON.parse`, and a ```` ```json ```` fence (which the grader emits more often
than not) threw and scored the trial FAIL regardless of the verdict.

The mock exercises those paths for free: `MOCK_CLAUDE_PASS=false` drives a tie
(exit 1), `MOCK_CLAUDE_GRADE_WRAP=fence|prose` the real grader's reply shapes,
and `MOCK_CLAUDE_GRADE_WRAP=drift|garbage` the unreadable path (exit 2).

On a Windows/Git-Bash box, note `/tmp` is `%LOCALAPPDATA%\Temp` — the printed
artifact path resolves there, not to a literal `C:\tmp`.

## Verifying the harness offline (free)

The fixture and both prompts are checkable with zero cost — this asserts the
input stays four-key-blinded and the two branches diverge exactly as the gate
tests pin, without any `claude -p`:

```bash
FIX=evals/reviewer/fixtures/multi-defect
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


**2026-07-27, ticket #108 round 3 (option (a): enlarge the fixture). Fixture
enlarged and verified; it still does NOT discriminate, and the reason is
structural rather than a matter of size.**

The fixture went from 45 lines of source with one function to a realistic
two-module keyed limiter: `src/window.ts` (three tiling helpers) plus
`src/limiter.ts` (`KeyedRateLimiter` with `allow` / `peek` / `remaining` /
`retryAfterMs` / `reset` / `resetAll` / `sweep` / `size`), 433 patch lines
across 4 files, 9 acceptance criteria, 12 independent edge classes, 37 shipped
tests. The planted defect moved to `peek`, which hand-rolls its window
membership test as `now - bucket.windowStart <= this.durationMs` (closed)
instead of routing through `withinWindow` (half-open). It is wrong ONLY at the
exact boundary tick AND only when the bucket is exhausted — a two-condition
conjunction requiring a three-call stateful construction that no acceptance
criterion states.

Verified mechanically before any reviewer saw it: the shipped suite is 37/37
green with the defect present; an exhaustive differential (`peek` vs a twin
limiter's `allow` across limits 1-3, durations 100/500, five call sequences,
every probe tick to 2200) finds exactly 14 mismatches, ALL of them at
`probe - windowStart == durationMs` and none anywhere else; `remaining`,
`retryAfterMs`, `sweep` and a 20,000-step `allow` budget walk are correct
throughout. Changing the one character to `<` drops the differential to 0
mismatches and keeps the suite 37/37 green. The module has exactly one defect,
in exactly the intended place.

**Red-team result: 6 single-pass reviewers, 6 catches, across two designs.**
Rather than spend the paid run to find out, the real single-pass prompt (built
by `stage-prompts.ts prompt reviewer --adversarial-mode off`) was driven
against the fixture by six independent frontier reviewers with code execution
and an isolated materialized worktree each. Every one returned
`REVIEW-FINDINGS` naming the defect at `src/limiter.ts:91` with a correct
repro. A first design was killed by an acceptance criterion that stated a
cross-function invariant ("any two parts of the module asked about the same
tick agree on which window it is in") — all three reviewers executed it
verbatim as a property check, the identical failure that killed round 1's
stated invariant. Removing that clause and adding `peek` tests at ticks 1499,
1500 and 1501 (all passing, so `peek` reads as thoroughly boundary-tested) did
not help: the second three reviewers additionally identified the boundary test
as constructed-to-pass, because it uses `limit 2` with a single charge where
its neighbours use `limit 1`.

**Why enlarging cannot fix this.** All six reviewers named the same tell, in
their own words: `peek` is *the only place in the diff that computes window
membership without calling `withinWindow`*. They found the defect by
inconsistency detection, not by exhaustive reading — so the fixture's size is
irrelevant to the search. The whole 433-line diff contains just 9 comparison
sites and exactly one inline membership test; a 4,000-line diff would contain
a few dozen and still exactly one, and it stays greppable. Single-pass
attention was never the bottleneck the option-(a) framing assumed it was.

That generalizes to a case analysis over the defect class `rubric.md` mandates
(a criterion-3 boundary/off-by-one). Such a defect can sit (i) inline at a call
site where a correct helper exists — locally inconsistent, which is what all
six caught; (ii) inside the helper itself — but criterion 3 states
`withinWindow(1500, 1000, 500)` → `false` as a literal example, so a
code-executing reviewer runs it and catches it every time (this is what killed
#102); or (iii) in a wrong argument passed to a correct helper — still a
single anomalous call site. There is no fourth place to put it.

**Score: not run.** A paid `run.sh 5` was not spent, because a trial passes
only when single-pass MISSES, and single-pass caught it 6/6 under conditions
at least as favourable as the eval's. The expected score is 0/5 for the same
reason #102 and round 2 scored 0/5. The enlarged fixture is committed anyway:
it is a strictly better artifact than what it replaces (a real multi-function
surface, exhaustively verified, no `git apply` whitespace noise) and it is the
right substrate the moment the defect class is unfrozen.

**The open decision is now narrower than "make the defect subtler."** The
mandated defect class and the goal are in conflict, and one of them has to
move:
- (i) Unfreeze the defect class. Let the plant be a defect that is NOT locally
  anomalous — an emergent interaction between two individually-correct
  functions (a capacity/eviction breach, a per-key isolation leak, an
  ordering-dependent state bug). That requires editing `rubric.md`'s
  "## The planted defect" section and its criterion-3 grading contract, which
  #108 AC3 currently forbids, so it needs an explicit amendment to AC3.
- (ii) Revise the claim. Accept that a single-pass frontier reviewer with code
  execution catches locally-anomalous defects reliably, and re-target the eval
  at what the fan-out plausibly does buy — breadth of coverage across many
  independent findings — rather than a single planted needle.


**2026-07-27, 5 trials, human-run on `main`'s fixture. Score: 0/5 — a clean
reproduction of #102, not a measurement of any round-1-to-3 redesign.** The
`run.sh 5` run was made from a branch that still carried the ORIGINAL
`<=`-vs-`<` fixture (every redesign lives on #108's ticket branch, unmerged), so
it measured round 0. All five graders parsed — three bare JSON, one fenced, one
schema-drifted to booleans — and `evals/lib/grade.ts` read all five, confirming
the #108 grader-parse fix works and that this 0/5 is a graded score rather than
the old "unreadable graded as FAIL". All five single-pass outputs named
`src/window.ts:8` with the same executed counter-example. The run also surfaced
the CRLF issue now fixed in `.gitattributes`: `git apply` reported "trailing
whitespace" on 21 added lines because a Windows checkout rewrote `diff.patch` to
CRLF.

**2026-07-28, ticket #108 round 4 (option (i): the defect class unfrozen). The
fixture is rebuilt around a non-anomalous ordering defect and verified; a
single-pass reviewer still catches it 4/4. With rounds 1-3 that is 16 real
single-pass reads over three defect classes and 16 catches, and the reason is
now structural in a way no fixture inside this harness can route around.**

The AC3 amendment (recorded on #108) unfroze the *defect class* — `rubric.md`'s
"## The planted defect" description and the criterion-3 clause in its grading
contract — while leaving the ≥4/5 threshold and the single-pass-must-approve
delta rule frozen. The fixture was rebuilt to use it.

**The round-4 fixture.** `src/limiter.ts` gains a shared process-wide ceiling
(`globalLimit`) over the per-key budgets, and round 3's `peek` tell is gone —
`peek` now routes through `withinWindow` like everything else, so no line in the
diff computes window membership its own way. The planted defect is an ordering
interaction between two individually-correct pieces: `allow()` charges the
shared ceiling (`admitShared`, a correct global limiter on its own) BEFORE it
checks the key's own budget (`live()`, a correct per-key roll on its own), so a
request the per-key budget turns away has already spent a shared slot. The
ceiling ends up counting arrivals where criterion 5 defines it over admissions,
and one key hammering a closed budget starves every other key (criterion 4).
Swapping the two guard lines is the whole fix.

Verified mechanically before any reviewer saw it: 46/46 tests green with the
defect present, typecheck clean, and an exhaustive differential against an
independently written reference model (per-key limits 1-3 × ceilings 1-4 × all
3⁶ key sequences over a tick schedule that crosses a window boundary — 8,748
sequences, 52,488 calls) finds 990 mismatches, **every one** of them the shipped
code rejecting what the model admits, and **every one** preceded by an earlier
rejection in the same window. With no ceiling configured the differential is 0
mismatches: the defect is unreachable without `globalLimit`. Swapping the two
lines takes the differential to 0 everywhere and keeps all 46 tests green, so
the module holds exactly one defect in exactly the intended place. The shipped
suite covers per-key isolation and the ceiling separately but never pairs
rejected traffic with a second key under a tight ceiling, which is the only
construction that shows the bug.

**Red-team result: 4 single-pass reviewers, 4 catches.** The real single-pass
prompt (`stage-prompts.ts prompt reviewer --adversarial-mode off`) was driven
against the fixture by four independent frontier reviewers with code execution
and the materialized worktree, exactly as `run.sh` builds it. All four returned
`REVIEW-FINDINGS` naming `src/limiter.ts:91-92` with a correct mechanism; one
opened "probed the one ordering I distrusted", another "the diff still has a
defect the suite does not exercise", a third named criteria 5 and 4 explicitly.
Removing the local anomaly did not help, because they were not finding it by
inconsistency detection this time — they were auditing criterion 5 against the
code that implements it.

**The adversarial half and the amended grading contract were validated live.**
One adversarial trial plus one grader run (paid, roughly a fifth of a full
`run.sh 5`) against the same materialized worktree: the fan-out returned
`REVIEW-FINDINGS: confidence=0` — 3/3 skeptics refuting, all three
independently landing on the planted defect, the reviewer reproducing it
itself. The grader, reading the AMENDED `rubric.md`, returned
`namesDefect: true` for the new defect class and `pass: false` solely on rubric
condition 2 (single-pass also caught it), and `evals/lib/grade.ts` read its
fenced JSON as a graded FAIL rather than an unreadable one. So nothing in the
fan-out or the grading contract is broken: adversarial finds the defect, the
rubric scores it, and the trial still fails purely because there is no delta.

**Why no fixture in this harness can produce the delta.** The reviewer is given
the complete acceptance criteria and the complete diff, and it executes code. A
planted defect must violate a stated criterion, or the rubric cannot grade it —
so the criteria list is a complete index into where the defect can be. A
code-executing reviewer audits each criterion against its implementation, which
means it reads the defect's home function under suspicion no matter how the
defect is written. That closes all three doors at once: stated-executably (round
1), locally anomalous (rounds 2-3), and non-anomalous but criterion-indexed
(round 4). Enlarging the diff does not help — round 3 went to 433 lines and this
round to 529 — because the audit is driven by the criteria list, not the line
count.

The arithmetic says the same thing from the other side. Single-pass and the
three skeptics are the same model on the same blinded inputs. If catching were
independent with probability *p*, a trial passes with probability
`(1-p)·(1-(1-p)³)`, which peaks at **~47%** (p≈0.37) — so even at the
theoretical optimum P(≥4/5) ≈ 0.15, and same-model draws are correlated, not
independent, which only makes it worse. A ≥4/5 score therefore requires a
*structural* asymmetry — the refute framing systematically finding what the
verify-then-approve framing systematically stops short of — not a luckier
fixture. Sixteen reads say the criteria-driven audit removes that asymmetry.

**Score: no full `run.sh 5` spent** (only the four single-pass probes and the
one adversarial + grader trial above). A trial passes only when single-pass
MISSES, and single-pass caught this 4/4 under conditions identical to the
eval's — the one graded trial that did run scored FAIL on exactly that. The
expected headline is 0/5 for the same reason #102, round 2 and round 3 were
0/5. The round-4 fixture is committed regardless: it is the better artifact
(non-anomalous defect, 46 tests, exhaustively differentiated, LF-clean patch)
and it is what any re-targeted claim would be measured against.

**What is left is a claim decision, not a fixture decision.** The eval's
per-trial contract — adversarial catches AND single-pass approves — cannot be
satisfied by fixture design inside a harness that hands the reviewer every
criterion and every line. Two ways forward, both needing a human call:
- (a) Change the fixture FORMAT so the criteria stop indexing the defect: a
  small diff perturbing a large pre-existing codebase, where the changed lines
  are clean and the break is in unchanged code the diff does not show. `run.sh`
  materializes the worktree from `diff.patch` alone, so this needs a harness
  amendment (a base tree plus a patch), which #108 AC3 still forbids.
- (b) Re-target what the eval measures, at what the fan-out plausibly does buy:
  breadth across many independent findings in one diff, rather than one planted
  needle single-pass has to miss. That rewrites `rubric.md`'s pass contract and
  moves #59's claim and #113 with it.

**2026-07-28, 5 trials, ticket #183 (first paid run of the re-targeted recall
contract). Score: 2/5 — FAIL below threshold (exit 1), recorded honestly.**
`run.sh`'s own report, verbatim:

```
per-defect catch rate over 5 trials (single -> adversarial):
  D1 src/limiter.ts:allow         3/5 -> 5/5
  D2 src/limiter.ts:constructor   4/5 -> 5/5
  D3 src/middleware.ts (absence)  5/5 -> 5/5
  D4 src/middleware.ts:handle     5/5 -> 5/5
  D5 src/middleware.ts:handle     5/5 -> 5/5
  D6 src/middleware.ts:handle     5/5 -> 5/5
  D7 src/middleware.ts:handle     5/5 -> 5/5
  D8 src/middleware.test.ts       5/5 -> 5/5
mean recall: single 7.4/8 (93%), adversarial 8.0/8 (100%)
mean findings matching no planted defect: single 0.0, adversarial 0.6
adversarial named strictly more planted defects in 2/5 trials (pass threshold: 4/5)
```

All five grades parsed (no exit-2), and the grader was spot-checked against the
raw outputs: trials 4 and 5 genuinely lack the D1 finding in the single-pass
text and trial 5 also lacks D2, so the 2/5 is a measurement, not grader noise.

**Reading.** The re-targeted contract discriminates in the right direction —
adversarial was a perfect 40/40 across five trials while single-pass dropped
defects only in the hardest class (D1, the ordering interaction, missed 2/5;
D2, the missing validation, 1/5) — but the fixture saturates: six of eight
defects are surfaced 5/5 by BOTH modes, so three trials were 8-vs-8 ties and
ties are not passes. The signal and the fix are now visible in the same table:
to discriminate at ≥4/5 the fixture needs more defects in the D1 class
(stateful interactions between individually-correct paths) and fewer freebies
(D4-D8, each caught every time by everyone). That is a fixture-difficulty
iteration under an unchanged contract — the exact kind of tuning the old
single-needle rubric could never expose, because it had no per-defect table to
say WHICH defects carry the delta.

**Caveat on this run.** It predates the blindness hardening landed immediately
after: the reviewers ran with the repo as cwd, so `defects.json` was reachable
in principle. Against contamination: single-pass MISSED defects (a key-reader
would not), adversarial reported 0.6 findings per trial that match no key entry
(a key-reader would return exactly the eight), and every finding carries an
executed probe. Future runs are hardened regardless — both reviewer passes now
run from inside the throwaway worktree with only `$OUT` granted, gate-tested in
`tests/reviewer-recall.test.ts`.

**2026-07-28, 5 trials, ticket #183 iteration 2 (interaction-weighted fixture,
hardened blindness). Score: 1/5 — FAIL below threshold (exit 1), recorded
honestly.** `run.sh`'s report, verbatim:

```
per-defect catch rate over 5 trials (single -> adversarial):
  D1 src/limiter.ts:allow                 4/5 -> 5/5
  D2 src/limiter.ts:constructor           5/5 -> 5/5
  D3 src/limiter.ts:resetAll              0/5 -> 0/5
  D4 src/limiter.ts:retryAfterMs          5/5 -> 5/5
  D5 src/middleware.ts:handle             5/5 -> 5/5
  D6 src/middleware.ts:retryAfterSeconds  5/5 -> 5/5
  D7 src/middleware.ts:handle (catch)     5/5 -> 5/5
  D8 src/middleware.test.ts               5/5 -> 5/5
mean recall: single 6.8/8 (85%), adversarial 7.0/8 (88%)
mean findings matching no planted defect: single 0.2, adversarial 0.4
adversarial named strictly more planted defects in 1/5 trials (pass threshold: 4/5)
```

All five grades parsed. Grader verified against the raw text both ways: the one
strict win (trial 2: single 6, adversarial 7 — single missed D1) is real, and
the D3 misses are real — **zero of the ten reviewer outputs contain the string
`resetAll` at all**. This run used the hardened harness (reviewers cwd = the
throwaway worktree, answer key unreachable), so it carries no contamination
caveat.

**Reading 1 — the difficulty dial has two stable settings and a knife edge.**
Three of the four new interaction defects (D4 stale-window retry, D6 rounding
direction, D7 catch re-entry) were caught 5/5 by BOTH modes: each violates a
criterion a code-executing reviewer probes directly, and a probe that
constructs the state finds it regardless of how many paths interact. D3 — the
one defect whose two interacting pieces no criterion connects (nothing links
`resetAll` to the ceiling) — was caught by NOBODY: not one single-pass read,
not one of fifteen skeptics across five fan-outs. Between "probe-able from a
stated criterion" (everyone catches) and "no criterion hints at the
construction" (no one does) sits only the D1-style knife edge, and it is
narrow: across both paid runs single-pass missed D1 3 times in 10 while
adversarial caught it 10/10.

**Reading 2 — defects sharing a criterion mask each other.** D1 and D3 both
violate criterion 5. Every reviewer that audited criterion 5 found D1 first —
it is upstream in `allow()`, reachable by the criterion's own example — and
stopped hunting for a second violation of an already-violated criterion. A
fixture design rule for any future iteration: one planted defect per
criterion, or the second is invisible behind the first.

**Reading 3 — the eval is now measuring the mechanism, not the fixture.** Two
honest runs put the fan-out's value-add at +0.2 to +0.6 named defects per
review (93→100% and 85→88% mean recall), concentrated entirely on
ordering-interaction defects. The three skeptics run the SAME refute-the-diff
prompt against the SAME four inputs, so they inherit the same criteria-indexed
search the single pass uses — redundancy narrows variance (adversarial's
recall is more consistent) but does not widen the search. That is evidence
about issue #59's mechanism: a ≥4/5 strictly-more threshold is out of reach of
prompt-identical skeptics on criterion-complete tickets. What would plausibly
move it — skeptics with DIVERSE assignments (per-subsystem, per-criterion,
state-machine walking) so the fan-out searches space the single pass does not —
is a #59 mechanism change, out of scope for #183 and filed as a follow-up.

The threshold was not tuned to the result. The fixture stays as the better
substrate either way: eight verified defects, one of which (D3) is now a
standing example of a real bug the current adversarial mode cannot see.
