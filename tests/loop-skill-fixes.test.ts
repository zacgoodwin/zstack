// Doc-canary gates for the SKILL-level loop fixes in issue #14 (C3/H9/H13/H17/M22).
// These fixes live in z-loop/SKILL.md and z-plan/SKILL.md (the orchestrator can
// only execute what the SKILL tells it), so the gate scans the real skill files
// and would fail if a fix silently regressed. The one lib contract a skill fix
// leans on -- resolveSlug honoring ZSTACK_SLUG (H13) -- is asserted directly.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSlug } from "../lib/config.ts";
import { applyAction, type LoopState } from "../lib/loop.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const zLoop = () => readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
const zPlan = () => readFileSync(join(REPO_ROOT, "z-plan", "SKILL.md"), "utf8");

// Returns the body of a "## <heading>" section up to the next "## " heading.
function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start < 0) return "";
  const rest = md.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

// ============================================================================
// C3 -- wave reconciliation is reachable: the drain loop re-ingests every tick
// ============================================================================
describe("C3: drain loop re-reads the board before every next (via z-loop-tick)", () => {
  // Ticket #57 relocated the per-iteration snapshot+ingest+next block into
  // bin/z-loop-tick (Leak 2) so only the one-line Action re-enters context. The
  // C3 invariant -- board re-read + re-ingested BEFORE every `next` -- is
  // unchanged, just inside the wrapper now, so the canary checks both surfaces.
  test("Step 4 calls z-loop-tick every iteration (the re-read wrapper), before every next", () => {
    const step4 = section(zLoop(), "## Step 4 — The drain loop");
    expect(step4).not.toBe("");
    expect(step4).toContain("bin/z-loop-tick"); // the per-iteration tick
    expect(step4).toMatch(/before every/i); // re-read happens before every next
  });

  test("z-loop-tick re-reads the board (snapshot) then ingests, strictly before next", () => {
    const tick = readFileSync(join(REPO_ROOT, "bin", "z-loop-tick"), "utf8");
    expect(tick).toContain("snapshot");
    expect(tick).toContain('lib/loop.ts" ingest "$STATE"');
    expect(tick).toContain('lib/loop.ts" next "$STATE"');
    // snapshot -> ingest -> next, in that order.
    expect(tick.indexOf("snapshot")).toBeLessThan(tick.indexOf('ingest "$STATE"'));
    expect(tick.indexOf('ingest "$STATE"')).toBeLessThan(tick.indexOf('next "$STATE"'));
  });
});

// ============================================================================
// H9 -- dead merge worker: verify PR state before skipping
// ============================================================================
describe("H9: a dead merge lane is verified via gh pr view, not blind-skipped", () => {
  test("the SKILL documents the gh pr view check for merge lanes", () => {
    const md = zLoop();
    expect(md).toMatch(/gh pr view/);
    expect(md).toMatch(/merge/i);
    expect(md).toMatch(/mergedThisRun/); // the reason: a landed merge must be counted
  });
});

// ============================================================================
// H13 -- --slug never omitted: ZSTACK_SLUG exported once, resolveSlug honors it
// ============================================================================
describe("H13: ZSTACK_SLUG exported in both skills; resolveSlug honors it", () => {
  test("z-loop and z-plan both export ZSTACK_SLUG in setup", () => {
    expect(zLoop()).toContain('export ZSTACK_SLUG="$SLUG"');
    expect(zPlan()).toContain('export ZSTACK_SLUG="$SLUG"');
  });

  test("resolveSlug returns ZSTACK_SLUG when no explicit slug is passed (explicit still wins)", () => {
    const prev = process.env.ZSTACK_SLUG;
    try {
      process.env.ZSTACK_SLUG = "env-proj";
      // home points nowhere: without ZSTACK_SLUG this would throw "No zstack project".
      expect(resolveSlug(undefined, join(REPO_ROOT, "no-such-home"))).toBe("env-proj");
      expect(resolveSlug("explicit", join(REPO_ROOT, "no-such-home"))).toBe("explicit");
    } finally {
      if (prev === undefined) delete process.env.ZSTACK_SLUG;
      else process.env.ZSTACK_SLUG = prev;
    }
  });
});

// ============================================================================
// H17 -- loop counter is peeked mid-loop and bumped only after the report
// ============================================================================
describe("H17: counter peek at start, bump after the report", () => {
  test("Step 7a peeks (no write) up front and bumps last", () => {
    const md = zLoop();
    expect(md).toContain("counter peek"); // sizing the plan without persisting
    expect(md).toContain("counter bump"); // persisted at the end
    // The peek must come before the bump in the document.
    expect(md.indexOf("counter peek")).toBeLessThan(md.indexOf("counter bump"));
  });
});

// ============================================================================
// issue #82 -- per-stage model routing: the spawn step resolves through
// lib/loop.ts stage-model, not a literal "the ticket's Model field" read
// ============================================================================
describe("issue #82: Step 4's spawn resolves model via stage-model, not the ticket's Model field verbatim", () => {
  test("the SKILL invokes the stage-model resolver before spawning", () => {
    const md = zLoop();
    expect(md).toContain('lib/loop.ts" stage-model');
    expect(md).not.toContain("`model` = the ticket's Model field");
  });
});

// ============================================================================
// M22 -- red-path bug filing moves the NEW bug, not the drained ticket
// ============================================================================
describe("M22: red-path parses the created bug number", () => {
  test("the created number is parsed and moved; no bare `move <N> Backlog` placeholder", () => {
    const md = zLoop();
    expect(md).toContain("BUG_N=${NEW%% *}"); // parse the created issue number
    expect(md).toContain('"$Z_BOARD" move "$BUG_N" Backlog'); // move THAT bug
    expect(md).not.toContain('"$Z_BOARD" move <N> Backlog'); // the ambiguous placeholder is gone
  });
});

// ============================================================================
// ticket #83 AC4 -- stage-named transcript copies + --by-file in the
// end-of-loop report assembly
// ============================================================================
describe("ticket #83 AC4: stage-named transcript copies, --by-file in report assembly", () => {
  test("Step 4 names transcript copies <stage>-<attempt>.jsonl, not an unnamed file", () => {
    const step4 = section(zLoop(), "## Step 4");
    expect(step4).not.toBe("");
    expect(step4).toContain("<stage>-<attempt>.jsonl");
    expect(step4).toContain("builder`/`qa`/`reviewer`/`merge`");
  });

  test("Step 7a's report assembly calls z-cost --by-file over every stage's transcripts", () => {
    const step7a = section(zLoop(), "## Step 7a");
    expect(step7a).not.toBe("");
    expect(step7a).toContain("--by-file");
    expect(step7a).toContain('"$STATE_DIR/transcripts/*/*.jsonl"');
  });

  test("Step 7a feeds the --by-file result through endloop.ts spend-by-stage, into spendByStage", () => {
    const step7a = section(zLoop(), "## Step 7a");
    expect(step7a).toContain("lib/endloop.ts\" spend-by-stage");
    expect(step7a).toContain("spendByStage");
    // --by-file's cost result is produced BEFORE it's fed through spend-by-stage.
    expect(step7a.indexOf("--by-file")).toBeLessThan(step7a.indexOf("spend-by-stage"));
  });
});

// ============================================================================
// Ticket #85 -- exclude lockfiles from the adversarial reviewer diff
// ============================================================================
describe("Ticket #85: lockfile exclusion in reviewer diff", () => {
  // AC 1: z-loop/SKILL.md's reviewer input row carries all four exclude pathspecs exactly as written
  test("AC 1: reviewer row includes all four lockfile exclusion pathspecs", () => {
    const md = zLoop();
    const reviewerRow = section(md, "| `reviewer` |");
    expect(reviewerRow).not.toBe("");
    // Check all four pathspecs are present exactly as specified
    expect(reviewerRow).toContain("':(exclude)*.lock'");
    expect(reviewerRow).toContain("':(exclude)package-lock.json'");
    expect(reviewerRow).toContain("':(exclude)pnpm-lock.yaml'");
    expect(reviewerRow).toContain("':(exclude)yarn.lock'");
  });

  // AC 3: the SKILL.md text instructs falling back to the unfiltered diff when filtered diff is empty
  test("AC 3: reviewer row documents empty-diff fallback to unfiltered diff", () => {
    const md = zLoop();
    const reviewerRow = section(md, "| `reviewer` |");
    expect(reviewerRow).not.toBe("");
    // Check that the fallback pattern is documented
    expect(reviewerRow).toContain("[ ! -s");
    expect(reviewerRow).toContain("diff-<N>.txt"); // the temp file being checked
    expect(reviewerRow).toContain("lockfile-only"); // rationale
    expect(reviewerRow).toMatch(/fall.*back|fallback/i);
  });
});

// ============================================================================
// Issue #118 -- the throwaway review worktree must never resolve under
// ~/.zstack: the reviewer runs the full `bun test` suite inside it, and
// several tests write to/delete real ~/.zstack subtrees (notify.test.ts was
// one), so a worktree rooted there lets that suite's cleanup destroy the
// loop's own live state.json/locks/transcripts mid-run.
// ============================================================================
describe("Issue #118: throwaway review worktree is placed outside ~/.zstack", () => {
  test("AC1: the reviewer row's worktree add path is NOT under $TMP / ~/.zstack", () => {
    const md = zLoop();
    const reviewerRow = section(md, "| `reviewer` |");
    expect(reviewerRow).not.toBe("");
    // The old, dangerous placement must be gone.
    expect(reviewerRow).not.toContain('"$TMP/review-<N>"');
    // git worktree add's target for the throwaway review worktree, extracted
    // the same way section() extracts the reviewer row: find the exact
    // command and check ITS path argument, not just any mention of ".worktrees".
    const m = reviewerRow.match(/git worktree add "([^"]+)" <head-sha>/);
    expect(m).not.toBeNull();
    const worktreePath = m![1];
    // Must resolve outside ~/.zstack (repo .worktrees/ or an OS temp dir) --
    // verified by path prefix, per AC1's own wording.
    expect(worktreePath.startsWith(".worktrees/")).toBe(true);
    expect(worktreePath).not.toContain("$TMP");
    expect(worktreePath).not.toContain(".zstack");
  });

  // #209 changed WHEN the throwaway worktree is removed, never WHETHER: removal
  // is now gated on the whole spawn subtree finishing (the skeptics execute
  // inside it and outlive their parent), so the command lives in the Per-stage
  // Actual block behind that gate rather than inline in this row. #118's own
  // guarantee is unchanged and still pinned here -- the worktree is still
  // removed, and still at a path outside ~/.zstack (AC1 above).
  test("AC1: the reviewer row still documents removing the throwaway worktree, gated on the subtree", () => {
    const md = zLoop();
    const reviewerRow = section(md, "| `reviewer` |");
    expect(reviewerRow).toMatch(/remove it only once the whole spawn SUBTREE has finished/);
    expect(md).toContain('git worktree remove ".worktrees/review-<N>" --force');
  });
});

// ============================================================================
// Ticket #133 -- the batch-commit board move is deferred from Step 2 (up front,
// all at once) to Step 4's claim row, so the committed queue sits in Ready until
// each lane claims it. Doc-canaries: a silent revert (re-adding the Step 2 move,
// dropping the claim-row move, or resurrecting PROCESS step 7's up-front move)
// fails the suite. AC1/AC2 of the ticket.
// ============================================================================
describe("Ticket #133: the Building move is deferred to claim time, not batch-committed up front", () => {
  test("AC1: Step 2 commits the queue in place -- no up-front `move <N> Building` (no board writes)", () => {
    const step2 = section(zLoop(), "## Step 2");
    expect(step2).not.toBe("");
    expect(step2).not.toMatch(/move <N> Building/); // the old batch-commit loop is gone
    expect(step2).toMatch(/[Ll]eave them in Ready/); // the committed queue stays in Ready
  });

  test("AC2: Step 4's claim row performs the deferred move AFTER a successful claim, BEFORE the lane lock", () => {
    const claimRow = section(zLoop(), "| `claim N` |");
    expect(claimRow).not.toBe("");
    expect(claimRow).toContain("Deferred commit (#133)");
    expect(claimRow).toContain('"$Z_BOARD" move <N> <status>'); // mirrors STATUS_FOR_STAGE[stage]
    // Order: claim -> deferred move -> lane lock (a claim loser never moves a ticket).
    expect(claimRow.indexOf('claim <N> "$ME"')).toBeLessThan(claimRow.indexOf("move <N> <status>"));
    expect(claimRow.indexOf("move <N> <status>")).toBeLessThan(claimRow.indexOf("lane-write"));
  });

  test("PROCESS.md step 7 no longer moves the whole batch to Building up front", () => {
    const process = readFileSync(join(REPO_ROOT, "docs", "user-guide", "spec", "PROCESS.md"), "utf8");
    expect(process).not.toMatch(/Move every ticket in the work batch to \*\*Building\*\* up front/);
    expect(process).toMatch(/leave it in \*\*Ready\*\*/);
  });
});

// ============================================================================
// Ticket #138 -- lane-owned board moves take `--if-present`, so a ticket removed
// from the project mid-run releases its lane instead of wedging the tick on an
// exit-1 move. QA's finding on the first build: the rule was stated as universal
// at Step 4's preamble while Step 6 item 4 (`move <N> Done`, reached from the
// `complete N` row while the lane is still live) still used the bare form -- the
// exact wedge the ticket exists to close. The first canary below is the lint
// that makes any future omission unreachable rather than found by eye.
// ============================================================================
describe("Ticket #138: every lane-owned board move is --if-present", () => {
  // Lane-owned moves are exactly the ones targeting the lane's own ticket
  // placeholder `<N>`, in the two steps a lane runs under: Step 4's action table
  // and Step 6's completion flow. Deliberately NOT covered: Step 1/2's parks (no
  // lane exists yet), Step 6/7a's `move <new>|"$BUG_N" Backlog` (a just-created
  // ticket, never a lane), and Step 7b's reconcile prose (#149).
  test("no bare `move <N>` survives in Step 4 or Step 6", () => {
    const md = zLoop();
    for (const heading of ["## Step 4 — The drain loop", "## Step 6 — Completion"]) {
      const body = section(md, heading);
      expect(body).not.toBe("");
      // Each move sits in a code span; scan to that span's closing backtick.
      const moves = body.match(/move <N> [^`]*/g) ?? [];
      expect(moves.length).toBeGreaterThan(0); // the scan actually found the rows
      for (const m of moves) expect(m).toContain("--if-present");
    }
  });

  test("Step 6 item 4 recovers a moved:false Done by applying `complete`, not `stop-lane`", () => {
    const step6 = section(zLoop(), "## Step 6 — Completion");
    expect(step6).toContain("move <N> Done --if-present");
    expect(step6).toMatch(/moved:false/);
    expect(step6).toContain("mergedThisRun"); // names why complete cannot be swapped out
    expect(step6).not.toMatch(/apply .{0,20}stop-lane/); // never the park/skip recovery here
  });

  // The lib contract that recovery leans on: only `complete` records the merge,
  // so substituting `stop-lane` (the park/skip recovery) would silently drop the
  // stacked-child retarget record -- the same loss H9 refuses for a dead merge lane.
  test("only the `complete` reducer records mergedThisRun; `stop-lane` drops the lane and nothing else", () => {
    const base: LoopState = {
      tickets: [{ number: 7, title: "Ticket 7", status: "Review", dependsOn: [], model: "sonnet" }],
      lanes: [{ ticket: 7, stage: "merge", lastActivityMs: 0, qaBounces: 0, reviewBounces: 0 }],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [],
    };
    const completed = applyAction(base, { kind: "complete", ticket: 7, note: "merged" }, 1);
    expect(completed.lanes).toEqual([]);
    expect(completed.mergedThisRun).toEqual([7]);
    expect(completed.tickets[0]!.status).toBe("Done");

    const stopped = applyAction(base, { kind: "stop-lane", ticket: 7, note: "off the board" }, 1);
    expect(stopped.lanes).toEqual([]);
    expect(stopped.mergedThisRun).toEqual([]); // the retarget record would be lost
    expect(stopped.tickets[0]!.status).toBe("Review");
  });
});

// ============================================================================
// Ticket #209 -- the dead-worker re-spawn is only real if the orchestrator can
// execute it. lib/stage-prompts.ts renders the briefing from a `respawnNotes`
// key, and the orchestrator builds each spawn's input JSON from the "Input JSON
// fields" table -- so a `respawn` row that says to pass the note, over a table
// that never names the key, ships a transition whose whole payload is dropped.
// Both surfaces, pinned together.
// ============================================================================
describe("Ticket #209: the respawn action and the input-field table agree on respawnNotes", () => {
  // One table row, not `section`'s slice-to-next-heading (which would run past
  // the row and let a mention in a LATER row satisfy an assertion about this one).
  const row = (md: string, prefix: string) => md.split("\n").find((l) => l.startsWith(prefix)) ?? "";

  test("the respawn action row names the stages, the key, the cap, and the fresh spawn", () => {
    const r = row(zLoop(), "| `respawn N at S` |");
    expect(r).not.toBe("");
    expect(r).toContain("respawnNotes");
    expect(r).toContain("one re-spawn per stage per lane"); // the cap, per the Plan
    expect(r).toMatch(/[Nn]ever SendMessage/); // fresh spawn, never a resume
    expect(r).toContain("no board move"); // the lane never left this stage's status
  });

  test("the builder and qa input rows both name respawnNotes; the blinded reviewer row does not", () => {
    const md = zLoop();
    expect(row(md, "| `builder` |")).toContain("respawnNotes");
    expect(row(md, "| `qa` |")).toContain("respawnNotes");
    // RESPAWN_STAGES excludes the reviewer on purpose: its input is pinned to
    // exactly four blinded keys (assertReviewerInput), so a fifth would be
    // rejected by the constructor and the briefing has nowhere to live.
    expect(row(md, "| `reviewer` |")).not.toContain("respawnNotes");
  });

  test("check-worker collects the worktree's dirtiness before probing dead", () => {
    const r = row(zLoop(), "| `check-worker N` |");
    expect(r).toContain("status --porcelain --branch");
    expect(r).toContain("--porcelain");
    // Order: read the worktree, THEN probe -- a probe without it can only skip.
    expect(r.indexOf("status --porcelain --branch")).toBeLessThan(r.indexOf('probe "$STATE" <N> dead'));
  });

  // A dead spawn still spent money, and the ONLY window in which its spend is
  // reachable is before the respawn is applied: the spawn tag is a digest of
  // <attempt>, and applying the respawn spends respawns[<stage>] so `loop attempt`
  // returns the NEXT number forever after. Miss it and a recovered ticket goes
  // Done with an Actual covering only the spawn that survived -- the same silent
  // undercount #190 exists to prevent, and the one the Plan's "the prior spend is
  // still priced" promises against.
  test("check-worker prices the dead spawn BEFORE probing, and the respawn row does not re-collect", () => {
    const md = zLoop();
    const cw = row(md, "| `check-worker N` |");
    expect(cw).toContain("collect --tag");
    // Pricing comes first: before the porcelain read, before the probe.
    expect(cw.indexOf("collect --tag")).toBeLessThan(cw.indexOf("status --porcelain --branch"));
    expect(cw.indexOf("collect --tag")).toBeLessThan(cw.indexOf('probe "$STATE" <N> dead'));
    // And it names why this is the last chance.
    expect(cw).toMatch(/loop attempt.{0,120}dead spawn's number|dead spawn's number/);

    // The respawn row must not tell the orchestrator to collect again after apply:
    // the attempt has moved on, so that tag names the spawn about to be made.
    const rs = row(md, "| `respawn N at S` |");
    expect(rs).toContain("already priced");
    expect(rs).not.toContain("collect --tag");
  });

  // The Per-stage Actual block is the one place that copies transcripts, so it has
  // to admit the dead-worker caller or the check-worker row above points at prose
  // that only covers a clean finish.
  test("the Per-stage Actual block covers a dead stage agent, not only a finished one", () => {
    expect(section(zLoop(), "**Per-stage Actual")).toMatch(/found DEAD at `check-worker`/);
  });
});

// ============================================================================
// Ticket #209 (QA finding 2) -- the throwaway review worktree sweep is a
// COMMAND, not prose. #209 gated in-run removal on the reviewer's whole spawn
// subtree going quiet, which makes a leftover `.worktrees/review-<N>` the norm
// rather than the exception; the only sweep it leaned on was a Step 7 sentence
// with nothing to run, skipped by `context-clear` and by any crash. Nine
// leftovers had accumulated in this repo by the time anyone counted.
// ============================================================================
describe("Ticket #209: leftover review worktrees are swept by a command on every exit path", () => {
  test("Step 7's batch cleanup runs reconcile sweep-review", () => {
    const step7 = section(zLoop(), "## Step 7 — Exit");
    expect(step7).not.toBe("");
    expect(step7).toContain('lib/reconcile.ts" sweep-review');
  });

  test("Step 0 sweeps too -- after the lock acquire, covering context-clear and crash exits", () => {
    const md = zLoop();
    const step0 = section(md, "## Step 0");
    expect(step0).not.toBe("");
    expect(step0).toContain('lib/reconcile.ts" sweep-review');
    // Only safe once the acquire proved no other loop is running.
    expect(step0.indexOf('locks.ts" acquire')).toBeLessThan(step0.indexOf('reconcile.ts" sweep-review'));
    // And it is NOT part of the orphan refusal gate below it.
    expect(step0.indexOf('reconcile.ts" sweep-review')).toBeLessThan(step0.indexOf("HAS_ORPHANS"));
  });

  test("the --reconcile contract lists throwaway review worktrees among what it prunes", () => {
    const sec = section(zLoop(), "## `--reconcile` and the safety locks");
    expect(sec).not.toBe("");
    expect(sec).toMatch(/throwaway review worktrees/);
    expect(sec).toContain("review-<N>");
  });

  // Review finding 2: Step 7 justified its unconditional sweep with "every lane
  // is finished by the time this runs, so a subtree that still reads live here is
  // one that will never write again" -- which is the parent-returned-means-
  // subtree-finished assumption #209 exists to refute. The reviewer returns while
  // its skeptics execute BY DESIGN (it checks each at most once and stops
  // waiting), and on the last lane drain-complete fires minutes later. The prose
  // must not tell the orchestrator to retry or treat a deferral as a failure
  // either, or the gate gets worked around in the shell.
  test("Step 7 does not claim drain-complete proves the subtree finished", () => {
    const step7 = section(zLoop(), "## Step 7 — Exit");
    expect(step7).not.toContain("a subtree that still reads live here is one that will never write again");
    expect(step7).toContain("liveness gate");
    expect(step7).toMatch(/do not retry\s+it/i); // the prose wraps, so the gap is whitespace
  });

  test("the teardown gate points at those sweeps, not at a habit", () => {
    // section() stops at the next "## " heading (Step 5), so Step 7's own sweep
    // cannot satisfy this.
    const block = section(zLoop(), "**Worktree teardown is gated");
    expect(block).not.toBe("");
    expect(block).toContain("sweep-review");
    expect(block).not.toContain("Step 7's batch cleanup sweeps leftover review worktrees"); // the old prose-only promise
  });

  // AC7's rule is about the REMOVAL, not about one row: the gate was taught to the
  // stage-teardown row only, and this ticket's own review reproduced #66 anyway --
  // the orchestrator's `park N Blocked` cleanup force-removed `.worktrees/review-209`
  // while a skeptic was still working in it, following the SKILL exactly as written
  // (it said nothing either way). So the SKILL now names the only two places that
  // may remove one, and this pins the count: a third `git worktree remove` of a
  // review path anywhere in the file is a new ungated path.
  test("only the gated teardown removes a review worktree by hand", () => {
    const md = zLoop();
    const removals = md.match(/git worktree remove "\.worktrees\/review-[^"]*"/g) ?? [];
    expect(removals).toHaveLength(1);
    // ...and that one sits behind the subtree gate.
    const gate = md.indexOf('jq -r .subtreeDone "$TMP/collected-<N>.json"');
    expect(gate).toBeGreaterThan(-1);
    expect(md.indexOf(removals[0]!)).toBeGreaterThan(gate);

    // The rule itself is written down, and every lane-dropping row points at it.
    const rule = section(md, "**Removing a review worktree.**");
    // Booleans, not the section: a miss must not dump 60KB into the failure.
    expect(rule === "").toBe(false);
    expect(rule.includes("sweep-review")).toBe(true);
    expect(rule.includes("not in a park, not in a skip, not in a")).toBe(true);
    expect(md.match(/\(\*\*Removing a review worktree\*\* below\)/g)).toHaveLength(3);
  });
});

// ============================================================================
// Ticket #273 -- the positive-evidence block routes a gone ticket's LANE through
// stop-lane, instead of claiming the tick released it
// ============================================================================
// The prose was the other half of the defect. `lib/loop.ts` dropped the lane
// inside ingest and emitted no action; the SKILL said a positively-gone ticket
// had "its lane released", which read as "the tick already handled it" -- so no
// step anywhere tore down the background agent or removed the ticket-<N>.json
// lock. The reducer is fixed; this pins the instruction that has to match it,
// because the orchestrator can only execute what the SKILL tells it.
describe("Ticket #273: a gone ticket's lane is torn down by stop-lane, not by the tick", () => {
  test("the confirm-pass sentence no longer promises the tick releases the lane", () => {
    const md = zLoop();
    expect(md).toContain("positively gone → removed from state");
    expect(md).not.toContain("positively gone → its lane released");
    // Nothing anywhere may still claim a lane is released as a side effect of a
    // read; the release is only ever an applied action.
    expect(md).not.toMatch(/its lane released/);
  });

  test("the block names both gone arms and routes them to the stop-lane row", () => {
    const block = section(zLoop(), "**A gone ticket's LANE is stopped, never silently released (#273).**");
    expect(block === "").toBe(false);
    // Both positive observations that take a ticket out of reach.
    expect(block.includes("partitionKnownStatus")).toBe(true);
    expect(block.includes("does not drive")).toBe(true);
    // The action, and the teardown the row performs.
    expect(block.includes("`stop-lane`")).toBe(true);
    expect(block.includes("lane-remove")).toBe(true);
    expect(block.includes("background agent")).toBe(true);
    // The laneless case stays a plain removal -- there is nothing to tear down.
    expect(block.includes("no lane")).toBe(true);
    // And the drain interlock is stated where the operator reads it.
    expect(block.includes("drain-complete")).toBe(true);
  });

  test("the stop-lane row itself covers the gone case, not just a human move", () => {
    const row = zLoop()
      .split("\n")
      .find((l) => l.startsWith("| `stop-lane N` |"));
    expect(row).toBeDefined();
    expect(row!).toContain("#273");
    // Both structural flags are named, and named as FIELDS read off the action
    // JSON -- #209's rule, because a prose trigger is matched by whatever
    // sentence happens to contain it.
    expect(row!).toContain('`"dropTicket": true`');
    expect(row!).toContain('`"salvage": true`');
    expect(row!).toMatch(/never off the note/i);
    // The teardown the reducer relies on is still spelled out in the row.
    expect(row!).toContain("lane-remove");
  });

  // The other half of the same contract, and the one that was silently wrong:
  // the SKILL HAND-BUILDS a stop-lane for a ticket a `--if-present` move just
  // proved is off the project. Without dropTicket that ticket stays in state at a
  // workable status and the next tick spawns a paid agent into it.
  test("the --if-present recovery hand-builds its stop-lane WITH dropTicket", () => {
    const md = zLoop();
    const line = md.split("\n").find((l) => l.includes('"kind":"stop-lane"'));
    expect(line).toBeDefined();
    expect(line!).toContain('"dropTicket":true');
    // And the reason is written down where the operator reads it, not implied.
    const block = section(md, "**Lane moves are `--if-present` (#138).**");
    expect(block.includes("not optional here")).toBe(true);
    expect(block.includes("claim")).toBe(true);
  });
});

// ============================================================================
// #256 -- the watchdog measures SILENCE, and the SKILL says where it comes from
// ============================================================================
describe("#256: Step 5 documents the per-tick heartbeat, not a stage-age timer", () => {
  // The orchestrator does not run this by hand -- z-loop-tick does it (pinned in
  // tests/loop.test.ts). What Step 5 must carry is the MEANING, because the
  // operator reading a `check-worker` needs to know whether the loop observed
  // silence or just counted minutes, and because a tick's stderr note ("no
  // subtree observed") is the signal that a lane has silently degraded to the
  // old behavior.
  test("Step 5 states the baseline is subtree silence and names the heartbeat verb", () => {
    const step5 = section(zLoop(), "## Step 5 — Watchdog");
    expect(step5).not.toBe("");
    expect(step5).toContain("#256");
    expect(step5).toContain('loop.ts" heartbeat "$STATE"');
    expect(step5).toMatch(/silence, not stage age/i);
    // Both properties an operator can be surprised by.
    expect(step5).toMatch(/monotonic/i);
    expect(step5).toMatch(/stderr/);
  });
});
