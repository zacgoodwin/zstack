// Gate tests for the crash-recovery path of /z-loop's reconcile: the three
// defects that made "--reconcile the wedge away" either lie, destroy the thing it
// was saving, or rebuild work that already landed. Deterministic -- injected
// clocks, temp dirs, real git fixtures, zero network, zero writes to a real
// ~/.zstack.
//
//   #280  scan/apply resolved their worktrees dir from cwd, so from inside a lane
//         worktree they reported a clean board they never looked at.
//   #271  a park keeps its worktree and drops its lock, so the next run refused
//         to start and --reconcile deleted exactly what the park saved.
//   #272  a crash after `gh pr merge` succeeded left the board at Review, and the
//         INFLIGHT recovery sent an already-merged ticket back to Ready.
//
// The loop-lock and orphan-scan controls proper live in tests/safety.test.ts;
// these are the recovery-classification truth tables.
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ZError } from "../lib/config.ts";
import {
  listLaneLocks,
  listWorktreeRecords,
  main as locksMain,
  removeWorktreeRecord,
  worktreeRecordPath,
  writeLaneLock,
  writeWorktreeRecord,
} from "../lib/locks.ts";
import {
  applyReconcile,
  hasOrphans,
  planCleanRetained,
  main as reconcileMain,
  reconcilePlan,
  resolveLaneBranch,
  resolveRepoRoot,
  resolveWorktreesDir,
  scanOrphans,
  unresolvedMergeLanes,
  type Orphans,
  type ReconcileEffects,
} from "../lib/reconcile.ts";

const dirs: string[] = [];
function tmp(prefix = "zstack-recovery-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// A repo with one commit and an initial config, ready for worktrees/branches.
function initRepo(prefix = "zstack-repo-"): string {
  const root = tmp(prefix);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "gate@test");
  git(root, "config", "user.name", "gate");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  return root;
}

// ============================================================================
// #280 -- reconcile must never report a clean board it did not look at
// ============================================================================
// `scan` and `apply` defaulted their worktrees directory to `<cwd>/.worktrees`. A
// lane worktree has no `.worktrees` of its own, so run from inside one both
// commands read an empty directory and printed `hasOrphans: false` / `reconciled:
// nothing` with exit 0 -- byte-identical to a genuinely clean board. Hit live
// during loop run 15 with `.worktrees/ticket-261` sitting orphaned, and the Bash
// tool's cwd persists between calls, so "the shell is inside a worktree" is the
// ordinary state rather than an odd one.
//
// These build a REAL git repo with a REAL second worktree, because the whole
// defect lives in the difference between `--show-toplevel` (the worktree's own
// root) and `--git-common-dir` (the shared .git, whose parent is the main
// checkout). A faked directory tree cannot tell those two apart.
describe("#280: the worktrees dir resolves to the main checkout, not to cwd", () => {
  function repoWithWorktrees(): { root: string; inside: string; orphan: string } {
    const root = initRepo();
    mkdirSync(join(root, ".worktrees"));
    // Real worktrees, so `git worktree list` agrees they exist and a prune would
    // really have to remove them.
    git(root, "worktree", "add", join(".worktrees", "ticket-261"), "-b", "z/ticket-261-orphan");
    git(root, "worktree", "add", join(".worktrees", "ticket-999"), "-b", "z/ticket-999-elsewhere");
    return {
      root,
      inside: join(root, ".worktrees", "ticket-999"),
      orphan: join(root, ".worktrees", "ticket-261"),
    };
  }

  // The resolution itself. `--show-toplevel` would answer with `inside`.
  test("from inside a worktree the resolved root is the MAIN checkout", () => {
    const { root, inside } = repoWithWorktrees();
    const fromInside = resolveRepoRoot(inside);
    expect(fromInside).toBeDefined();
    expect(fromInside).toBe(resolveRepoRoot(root));
    // Compared by reconstruction rather than by string equality against `root`:
    // mkdtemp and git can disagree on symlinked temp roots (/var vs /private/var).
    expect(join(fromInside!, ".worktrees", "ticket-999")).toBe(inside);
  });

  // The part that actually lied: the SCAN answer from a worktree cwd.
  test("scanning from a worktree cwd finds the orphan; the pre-fix cwd default finds nothing", () => {
    const { root, inside } = repoWithWorktrees();
    const locksDir = tmp();
    // QA, not Building, so `buildingWithoutState` cannot rescue the pre-fix answer
    // -- which is exactly the shape run 15 hit: every orphan category empty.
    const board = [{ number: 261, status: "QA" as const }];

    const fixed = scanOrphans(locksDir, resolveWorktreesDir(undefined, inside, resolveRepoRoot(inside)).dir, board, 0);
    expect(hasOrphans(fixed)).toBe(true);
    expect(fixed.orphanWorktrees.map((w) => w.ticket)).toEqual([261, 999]);
    expect(reconcilePlan(fixed).some((a) => a.kind === "prune-worktree" && a.ticket === 261)).toBe(true);

    // The pre-fix behaviour, pinned so the regression is demonstrated rather than
    // asserted about: trusting cwd reports a clean board it never looked at, and
    // that answer is byte-identical to a genuinely clean one.
    const preFix = scanOrphans(locksDir, join(inside, ".worktrees"), board, 0);
    expect(hasOrphans(preFix)).toBe(false);
    expect(preFix.orphanWorktrees).toEqual([]);
    expect(reconcilePlan(preFix)).toEqual([]);

    // Same board, same second, from the repo root: identical to the fixed answer.
    const fromRoot = scanOrphans(locksDir, resolveWorktreesDir(undefined, root, resolveRepoRoot(root)).dir, board, 0);
    expect(fromRoot).toEqual(fixed);
  });

  // The explicit flag still wins outright -- every existing test passes
  // `--worktrees`, and none of them may start resolving a repo root instead.
  test("--worktrees wins over the resolved root, with no divergence note", () => {
    const { inside } = repoWithWorktrees();
    const explicit = tmp();
    const r = resolveWorktreesDir(explicit, inside, resolveRepoRoot(inside));
    expect(r.dir).toBe(explicit);
    expect(r.note).toBeUndefined();
  });

  // A surprising answer must be self-explaining, and only when it is surprising.
  test("the cwd/root divergence is announced, and only when it exists", () => {
    const { root, inside } = repoWithWorktrees();
    const diverged = resolveWorktreesDir(undefined, inside, resolveRepoRoot(inside));
    expect(diverged.note).toContain(inside);
    expect(diverged.note).toContain(resolveRepoRoot(inside)!);
    const atRoot = resolveRepoRoot(root)!;
    expect(resolveWorktreesDir(undefined, atRoot, atRoot).note).toBeUndefined();
  });

  // The note must not fire from the repo root itself, and on Windows that is not
  // free: git prints `D:/repo/.git` while process.cwd() gives `D:\repo`, so an
  // unnormalized comparison would print "resolved the repo root ..." on EVERY
  // invocation -- training the operator to ignore the one line that exists to
  // explain a surprising answer.
  test("cwd and the resolved root compare as locations, not as spellings", () => {
    const { root } = repoWithWorktrees();
    const prev = process.cwd();
    let note: string | undefined;
    try {
      process.chdir(root);
      note = resolveWorktreesDir(undefined, process.cwd(), resolveRepoRoot(process.cwd())).note;
    } finally {
      process.chdir(prev);
    }
    expect(note).toBeUndefined();
    // ...and the resolved root carries the platform's own separators, so the
    // worktrees path is not a mixed-separator string.
    expect(resolveRepoRoot(root)).toBe(resolve(resolveRepoRoot(root)!));
  });

  test("a non-git cwd resolves to no root at all", () => {
    expect(resolveRepoRoot(tmp("zstack-nogit-"))).toBeUndefined();
  });

  // The CLI half: `scan` REFUSES rather than printing a clean board. The refusal
  // lands before loadConfig, so no ~/.zstack and no real slug are needed -- and
  // that ordering is itself under test, which is why the message is asserted and
  // not just the exit code (a config error would also exit 1).
  test("`scan` outside a git repo refuses loudly instead of reporting zero orphans", async () => {
    const outside = tmp("zstack-nogit-");
    const prev = process.cwd();
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    let code: number;
    try {
      process.chdir(outside);
      code = await reconcileMain(["scan", "--slug", "no-such-project-zstack-gate"]);
    } finally {
      console.error = realError;
      process.chdir(prev);
    }
    expect(code).toBe(1);
    const said = errs.join("\n");
    expect(said).toContain("Cannot resolve the repository root");
    expect(said).toContain("--worktrees");
    expect(said).not.toContain("hasOrphans");
  });
});

// ============================================================================
// #271 -- a park's worktree and its lock live and die together
// ============================================================================
// `park N Questions`, `skip N` and `stop-lane N` all keep their worktree and drop
// their lane lock. scanOrphans classified a worktree by lock-absence alone, so the
// moment a lane parked, the worktree it kept ON PURPOSE became an orphan: the next
// run refused to start ("Orphans present") and the `--reconcile` it demanded
// force-removed exactly what the park was saving. Lock-absence cannot tell a park
// from a crash, because it is the same observation -- so the intent is recorded.
describe("#271: a retained worktree is an artifact, not an orphan", () => {
  const RETAINED = 41;
  const DISPOSABLE = 42;
  const CRASHED = 43;

  // All three kinds side by side, which is the only way this truth table is worth
  // anything: the fix must move exactly one of them.
  function threeKinds(): { locksDir: string; worktreesDir: string; orphans: Orphans } {
    const locksDir = tmp();
    const worktreesDir = tmp();
    for (const n of [RETAINED, DISPOSABLE, CRASHED]) mkdirSync(join(worktreesDir, `ticket-${n}`));
    writeWorktreeRecord(locksDir, { ticket: RETAINED, disposition: "retained", session: "s1", writtenAt: 5 });
    writeWorktreeRecord(locksDir, { ticket: DISPOSABLE, disposition: "disposable", session: "s1", writtenAt: 5 });
    // CRASHED deliberately gets no record: a genuine crash.
    const board = [
      { number: RETAINED, status: "Questions" as const },
      { number: DISPOSABLE, status: "Blocked" as const },
      { number: CRASHED, status: "Building" as const },
    ];
    return { locksDir, worktreesDir, orphans: scanOrphans(locksDir, worktreesDir, board, 10) };
  }

  // The user-visible half: a batch that only parked tickets must be able to
  // re-invoke /z-loop plainly. On main hasOrphans is true here and Step 0 5(b)
  // prints "Orphans present" and exits 1.
  test("a parked run starts again without --reconcile", () => {
    const locksDir = tmp();
    const worktreesDir = tmp();
    mkdirSync(join(worktreesDir, `ticket-${RETAINED}`));
    writeWorktreeRecord(locksDir, { ticket: RETAINED, disposition: "retained", session: "s1", writtenAt: 5 });
    const o = scanOrphans(locksDir, worktreesDir, [{ number: RETAINED, status: "Questions" }], 10);
    expect(o.orphanWorktrees).toEqual([]);
    expect(hasOrphans(o)).toBe(false);
    // Still REPORTED, so the scan does not simply hide what is on disk.
    expect(o.retainedWorktrees.map((w) => w.ticket)).toEqual([RETAINED]);
    expect(o.retainedWorktrees[0].session).toBe("s1");
  });

  // The two kinds that must NOT change: a crash (no record) and the salvage park
  // (#177's commit-retry, whose note promises the worktree does not survive --
  // which is why that park dumps a salvage patch first).
  test("a recordless crash and a `disposable` salvage park are both still orphans", () => {
    const { orphans } = threeKinds();
    expect(orphans.orphanWorktrees.map((w) => w.ticket)).toEqual([DISPOSABLE, CRASHED]);
    expect(hasOrphans(orphans)).toBe(true);
  });

  // The plan is where the destruction actually lived.
  test("reconcilePlan prunes the disposable and the crashed one, and never names the retained one", () => {
    const { orphans } = threeKinds();
    const plan = reconcilePlan(orphans);
    expect(
      plan
        .filter((a) => a.kind === "prune-worktree")
        .map((a) => a.ticket)
        .sort((x, y) => x - y)
    ).toEqual([DISPOSABLE, CRASHED]);
    expect(plan.some((a) => a.ticket === RETAINED)).toBe(false);
    // ...and it is not smuggled in under some other action kind either.
    expect(plan.every((a) => !("path" in a) || !a.path.includes(`ticket-${RETAINED}`))).toBe(true);
  });

  // Kept does not mean kept forever -- but removing it is an explicit act, never
  // a side effect of recovering from a crash (reconcile's contract).
  test("clean-retained removes ONLY the retained one, and reconcilePlan never emits it", () => {
    const { orphans } = threeKinds();
    expect(planCleanRetained(orphans)).toEqual([
      { kind: "drop-retained", ticket: RETAINED, path: orphans.retainedWorktrees[0].worktreePath },
    ]);
    expect(reconcilePlan(orphans).some((a) => a.kind === "drop-retained")).toBe(false);
  });

  // The record is a locks-directory citizen: it must not be mistaken for a lane
  // lock, in either direction, and a live lane lock must outrank it.
  test("worktree records and lane locks never read as one another", () => {
    const locksDir = tmp();
    writeLaneLock(locksDir, { ticket: 7, stage: "builder", session: "s", claimedAt: 0 });
    writeWorktreeRecord(locksDir, { ticket: 7, disposition: "retained", session: "s", writtenAt: 0 });
    expect(listLaneLocks(locksDir).map((l) => l.lock.ticket)).toEqual([7]);
    expect(listWorktreeRecords(locksDir).map((r) => r.record.ticket)).toEqual([7]);

    // A ticket with a lane lock is a crashed LANE, not a retained worktree: the
    // lock is the stronger fact and reconcile checks it first.
    const worktreesDir = tmp();
    mkdirSync(join(worktreesDir, "ticket-7"));
    const o = scanOrphans(locksDir, worktreesDir, [{ number: 7, status: "Building" }], 0);
    expect(o.crashedLanes.map((c) => c.ticket)).toEqual([7]);
    expect(o.retainedWorktrees).toEqual([]);
    expect(o.orphanWorktrees).toEqual([]);
  });

  // A corrupt record must NOT degrade to "no record", because "no record" means "a
  // crash" and a crash gets force-pruned. Fail loud instead of resolving to the
  // destructive answer.
  test("a corrupt worktree record throws instead of resolving to the destructive answer", () => {
    const locksDir = tmp();
    writeFileSync(worktreeRecordPath(locksDir, 8), "{ not json");
    expect(() => listWorktreeRecords(locksDir)).toThrow(ZError);
    expect(() => listWorktreeRecords(locksDir)).toThrow(/is not valid JSON/);

    writeFileSync(worktreeRecordPath(locksDir, 8), JSON.stringify({ ticket: 8, disposition: "keep" }));
    expect(() => listWorktreeRecords(locksDir)).toThrow(/must be \{ticket, disposition/);
  });

  // The CLI the SKILL's park/skip/stop-lane/complete rows call, round-tripped.
  test("the locks CLI records and forgets a disposition, and rejects a bad one", () => {
    const d = tmp();
    expect(
      locksMain(["worktree-record", "--dir", d, String(RETAINED), "retained", "--session", "s1", "--now", "5"])
    ).toBe(0);
    expect(listWorktreeRecords(d)).toEqual([
      {
        path: worktreeRecordPath(d, RETAINED),
        record: { ticket: RETAINED, disposition: "retained", session: "s1", writtenAt: 5 },
      },
    ]);
    expect(locksMain(["worktree-record", "--dir", d, "9", "keep-forever", "--session", "s1"])).toBe(1);
    expect(locksMain(["worktree-forget", "--dir", d, String(RETAINED)])).toBe(0);
    expect(listWorktreeRecords(d)).toEqual([]);
    expect(locksMain(["worktree-forget", "--dir", d, "404"])).toBe(0); // idempotent
  });

  // The record describes a directory, so it must not outlive one: a stale
  // `retained` record would make a later re-claim of that ticket read as "a human
  // is inspecting this".
  test("pruning a worktree drops its record too", async () => {
    const locksDir = tmp();
    const worktreesDir = tmp();
    mkdirSync(join(worktreesDir, `ticket-${CRASHED}`));
    writeWorktreeRecord(locksDir, { ticket: CRASHED, disposition: "disposable", session: "s1", writtenAt: 0 });
    const o = scanOrphans(locksDir, worktreesDir, [{ number: CRASHED, status: "Building" }], 0);
    const fx: ReconcileEffects = {
      removeLock: () => {},
      // What realEffects does alongside the git removal; the git half needs a real
      // worktree and is covered by #280's fixtures.
      pruneWorktree: (t) => removeWorktreeRecord(locksDir, t),
      parkReady: () => {},
      releaseClaim: () => {},
      recordMerged: () => {},
      dropRetained: () => {},
    };
    await applyReconcile(reconcilePlan(o), fx);
    expect(existsSync(worktreeRecordPath(locksDir, CRASHED))).toBe(false);
  });
});

// ============================================================================
// #272 -- reconcile must not requeue a ticket whose code is already on main
// ============================================================================
// STATUS_FOR_STAGE.merge is "Review" and INFLIGHT includes "Review", so a crash
// between `gh pr merge` returning success and the loop recording its MERGED marker
// left a lane lock on a ticket the board still showed as Review -- and
// reconcilePlan took the INFLIGHT branch unconditionally: release, prune, park to
// Ready. A ticket already on main went back to be rebuilt, and the rebuild then
// hard-failed because reconcile never deletes a branch and `claim`'s `git worktree
// add -b` aborts on an existing one. The live watchdog already refuses to
// blind-skip that lane (#14 H9); this is the same failure reached by a crash.
describe("#272: a crashed merge lane is checked for merged-ness before requeue", () => {
  function mergeLane(prOutcome?: "merged" | "open"): Orphans {
    const locksDir = tmp();
    const worktreesDir = tmp();
    writeLaneLock(locksDir, { ticket: 77, stage: "merge", session: "dead", claimedAt: 0 });
    mkdirSync(join(worktreesDir, "ticket-77"));
    const o = scanOrphans(locksDir, worktreesDir, [{ number: 77, status: "Review" }], 60_000);
    // Exactly what the CLI does: one lookup for this lane only, threaded in, so
    // reconcilePlan stays pure.
    o.crashedLanes[0].branch = "z/ticket-77-thing";
    o.crashedLanes[0].prOutcome = prOutcome;
    if (prOutcome !== undefined) o.crashedLanes[0].prUrl = "https://pr/77";
    return o;
  }

  // On main this plan is release-claim + prune-worktree + park-ready +
  // remove-lock, and the ticket is rebuilt on top of its own merged code.
  test("a MERGED PR is recorded Done, never released and never parked to Ready", () => {
    const plan = reconcilePlan(mergeLane("merged"));
    expect(plan.map((a) => a.kind)).toEqual(["record-merged", "prune-worktree", "remove-lock"]);
    expect(plan.some((a) => a.kind === "release-claim")).toBe(false);
    expect(plan.some((a) => a.kind === "park-ready")).toBe(false);
    expect(plan[0]).toEqual({ kind: "record-merged", ticket: 77, url: "https://pr/77" });
  });

  // The genuinely-unmerged case must be byte-identical to before, or this fix has
  // traded one loss for another.
  test("an OPEN PR still recovers exactly as it did before", () => {
    expect(reconcilePlan(mergeLane("open")).map((a) => a.kind)).toEqual([
      "release-claim",
      "prune-worktree",
      "park-ready",
      "remove-lock",
    ]);
  });

  // The whole point of the class. An unreadable lookup is not evidence of an
  // unmerged PR (#138), so the lane is left exactly as found and NAMED for a
  // human -- because "0 actions" would otherwise read as "nothing to do", which is
  // #280's lesson applied one function over.
  test("an unreadable PR lookup fails closed: no park, no record, and the lane is reported", () => {
    const o = mergeLane(undefined);
    expect(reconcilePlan(o)).toEqual([]);
    expect(unresolvedMergeLanes(o)).toEqual([77]);
    // Holding costs nothing: the lock and worktree are untouched.
    expect(existsSync(o.crashedLanes[0].lockPath)).toBe(true);
    expect(existsSync(o.crashedLanes[0].worktreePath!)).toBe(true);
  });

  // The lookup is scoped to the ONE shape that can lose a merge. Every other
  // crashed lane costs no PR read and plans identically to before -- including a
  // `merge` lane whose ticket a human already moved to a terminal status.
  test("no other crashed lane is a merge lane, so none of them changes", () => {
    for (const [stage, status] of [
      ["builder", "Building"],
      ["qa", "QA"],
      ["reviewer", "Review"],
      ["merge", "Done"],
    ] as const) {
      const locksDir = tmp();
      const worktreesDir = tmp();
      writeLaneLock(locksDir, { ticket: 88, stage, session: "dead", claimedAt: 0 });
      mkdirSync(join(worktreesDir, "ticket-88"));
      const o = scanOrphans(locksDir, worktreesDir, [{ number: 88, status }], 60_000);
      expect(unresolvedMergeLanes(o)).toEqual([]); // nothing to look up
      expect(reconcilePlan(o).map((a) => a.kind)).toEqual(
        status === "Done"
          ? ["prune-worktree", "remove-lock"] // TERMINAL: never reopened (#14 C4)
          : ["release-claim", "prune-worktree", "park-ready", "remove-lock"]
      );
    }
  });

  // The branch is what the PR lookup is keyed on, and keying it wrong is how a
  // ticket gets wrongly marked Done. Ambiguity therefore resolves to "no answer",
  // which fails closed one layer up.
  test("resolveLaneBranch takes exactly one match, and no answer when there are two", () => {
    const root = initRepo();
    expect(resolveLaneBranch(root, 77)).toBeUndefined(); // no branch yet
    git(root, "branch", "z/ticket-77-thing");
    expect(resolveLaneBranch(root, 77)).toBe("z/ticket-77-thing");
    git(root, "branch", "z/ticket-77-thing-renamed"); // a re-claim under a different slug
    expect(resolveLaneBranch(root, 77)).toBeUndefined(); // ambiguous -> refuse to guess
  });

  // The lane worktree's own HEAD is the stronger source and wins over the branch
  // listing, so a re-claim's extra branch cannot misattribute a live lane.
  test("resolveLaneBranch prefers the lane worktree's own HEAD", () => {
    const root = initRepo();
    mkdirSync(join(root, ".worktrees"));
    git(root, "worktree", "add", join(".worktrees", "ticket-77"), "-b", "z/ticket-77-real");
    git(root, "branch", "z/ticket-77-decoy");
    expect(resolveLaneBranch(root, 77, join(root, ".worktrees", "ticket-77"))).toBe("z/ticket-77-real");
  });
});
