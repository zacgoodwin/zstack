// Doc-canary gates for the SKILL-level loop fixes in issue #14 (C3/H9/H13/H17/M22).
// These fixes live in z-loop/SKILL.md and z-plan/SKILL.md (the orchestrator can
// only execute what the SKILL tells it), so the gate scans the real skill files
// and would fail if a fix silently regressed. The one lib contract a skill fix
// leans on -- resolveSlug honoring ZSTACK_SLUG (H13) -- is asserted directly.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSlug } from "../lib/config.ts";
import { applyAction, owedBoardWrite, type LoopState } from "../lib/loop.ts";

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

  test("AC1: the reviewer row still documents removing the throwaway worktree after the stage", () => {
    const md = zLoop();
    const reviewerRow = section(md, "| `reviewer` |");
    expect(reviewerRow).toMatch(/remove it after the stage/);
    expect(reviewerRow).toContain('git worktree remove ".worktrees/review-<N>"');
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
// Ticket #205 -- the `advance N to S` row writes the board. Before this, the row
// named a lane-lock re-stamp, an apply, and a spawn, and NO `z-board move`: the
// reducer recorded the new status and stamped the #125 in-flight-write marker
// while the board stayed a stage behind the lane, permanently. The expensive
// consequence is the resume path, which picks a crashed ticket's stage from the
// BOARD status -- a lane at qa reading Building comes back as a builder and
// rebuilds committed work. Doc-canary: dropping the move again fails the suite.
// ============================================================================
describe("Ticket #205: the advance row moves the board to the new stage's status", () => {
  // Just the one table row -- `section()` would run to the end of Step 4 and pick
  // up the park/skip rows' moves.
  function advanceRow(): string {
    const row = zLoop().split("\n").find((l) => l.startsWith("| `advance N to S` |"));
    return row ?? "";
  }

  test("AC1: the row performs `z-board move <N> <status>` mirroring STATUS_FOR_STAGE, --if-present like every other lane move", () => {
    const row = advanceRow();
    expect(row).not.toBe("");
    expect(row).toContain('"$Z_BOARD" move <N> <status> --if-present');
    expect(row).toContain("STATUS_FOR_STAGE[S]");
    for (const pair of ["`builder`→`Building`", "`qa`→`QA`", "`reviewer`→`Review`"]) expect(row).toContain(pair);
  });

  test("the row names what an advance to `merge` writes instead of leaving it to the reader", () => {
    const row = advanceRow();
    expect(row).toContain("`merge`→`Review`");
    expect(row).toMatch(/merge has no status of its own/);
  });

  test("order: lane lock -> apply -> board move -> spawn (the marker must exist before the write)", () => {
    const row = advanceRow();
    const lock = row.indexOf("lane-write");
    const apply = row.indexOf("2. Apply");
    const move = row.indexOf("move <N> <status>");
    const spawn = row.indexOf("4. Spawn stage S fresh");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(apply);
    expect(apply).toBeLessThan(move);
    expect(move).toBeLessThan(spawn);
  });

  test("the row states the cost of skipping it, so it cannot be read as optional bookkeeping", () => {
    const row = advanceRow();
    expect(row).toMatch(/never skip this/i);
    expect(row).toMatch(/rebuild/i);
  });

  // The lib half: `apply` cannot make the write (pure reducer, board.ts is the
  // sole gh caller) but it derives and PRINTS it, so the row and the tool agree.
  test("owedBoardWrite derives exactly the statuses the row names", () => {
    expect(owedBoardWrite({ kind: "advance", ticket: 5, to: "builder" })).toEqual({ ticket: 5, status: "Building" });
    expect(owedBoardWrite({ kind: "advance", ticket: 5, to: "qa" })).toEqual({ ticket: 5, status: "QA" });
    expect(owedBoardWrite({ kind: "advance", ticket: 5, to: "reviewer" })).toEqual({ ticket: 5, status: "Review" });
    expect(owedBoardWrite({ kind: "advance", ticket: 5, to: "merge" })).toEqual({ ticket: 5, status: "Review" });
  });

  test("docs/user-guide keeps the user-facing contract in step with the row", () => {
    const zloopDoc = readFileSync(join(REPO_ROOT, "docs", "user-guide", "z-loop.md"), "utf8");
    expect(zloopDoc).toMatch(/Every stage transition writes the board/);
    expect(zloopDoc).toContain("STATUS_FOR_STAGE[stage]");

    const trouble = readFileSync(join(REPO_ROOT, "docs", "user-guide", "troubleshooting.md"), "utf8");
    expect(trouble).toMatch(/board says Building for a ticket the loop is actually QA-ing or reviewing/i);
    expect(trouble).toMatch(/resumed run rebuilt work that was already committed/i);
    expect(trouble).toContain("board write owed: z-board move 168 QA --if-present");
  });
});
