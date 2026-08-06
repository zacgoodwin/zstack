// Gate tests for #288: a crashed loop lock must be clearable without waiting out
// `lockStalenessMinutes`, and a live one must never be clearable at all -- with
// liveness PROVEN rather than guessed from age.
//
// The wedge this closes: production recorded no pid (#164 correctly rejected the
// SKILL's `$$`, which is the Bash tool's shell and exits the moment the acquire
// returns), so `loopLockLiveness`'s pid arm never ran and the age heuristic was
// the only branch reached. A loop that died five minutes ago therefore read LIVE
// for the rest of the hour; `acquireLoopLock` refuses a live lock even with
// --reconcile, `assertNotReconcilingLiveLoop` refuses too, and the only way out
// was `rm loop.lock` by hand -- which is what happened on 2026-08-02.
//
// The fix is not a new liveness mechanism. Claude Code exports CLAUDE_PID, the
// harness process that owns the session, whose lifetime IS the drain's lifetime;
// recording it makes the pid arm that already existed for #14 H12 actually run.
// So these tests are mostly about the three ARMS and the escape hatch, plus the
// cross-machine hazard that turning the arm on exposed.
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLoopLock,
  forceReleaseLoopLock,
  harnessPid,
  heartbeatPath,
  livenessEvidence,
  loopLockLiveness,
  loopLockPath,
  main as locksMain,
  processStartTime,
  readLoopLock,
  writeLaneLock,
  type LoopLock,
} from "../lib/locks.ts";
import { assertNotReconcilingLiveLoop } from "../lib/reconcile.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "zstack-liveness-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const STALE = 60 * 60_000; // the shipped default, 60 minutes
const HOST = hostname();

// A lock as production now writes one: session, host, harness pid, and the pid's
// OS start-time captured at creation.
function lockFile(locksDir: string, over: Partial<LoopLock> = {}): LoopLock {
  const lock: LoopLock = { session: "dead-loop", startedAt: 0, host: HOST, ...over };
  writeFileSync(loopLockPath(locksDir), JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

// ============================================================================
// harnessPid -- the pid that was missing
// ============================================================================
describe("#288: CLAUDE_PID is the process whose death is the loop's death", () => {
  test("it is read from the environment, and a bad value degrades to undefined", () => {
    expect(harnessPid({ CLAUDE_PID: "41644" } as NodeJS.ProcessEnv)).toBe(41644);
    // Every rejected shape falls back to "no pid recorded", i.e. today's age
    // heuristic -- never to a wrong pid, which would pin a lock live forever.
    for (const bad of [undefined, "", "0", "-1", "12.5", "abc", "1e3x"]) {
      expect(harnessPid({ ...(bad === undefined ? {} : { CLAUDE_PID: bad }) } as NodeJS.ProcessEnv)).toBeUndefined();
    }
  });

  // The claim the whole ticket rests on, checked against the real environment
  // this suite runs in rather than asserted. Reported as SKIP -- not as a silent
  // pass -- where the variable is not exported (a plain `bun test` outside Claude
  // Code), because its absence is a supported degradation but "0 assertions ran"
  // must never look like "the claim held".
  test.skipIf(harnessPid() === undefined)("the exported CLAUDE_PID names a live, identity-confirmable process", () => {
    const pid = harnessPid()!;
    const startTime = processStartTime(pid);
    expect(startTime).not.toBeNull();
    const lock: LoopLock = { session: "s", startedAt: 0, pid, host: HOST, startTime: startTime! };
    // Past the staleness window and still LIVE -- proof outranks age.
    expect(loopLockLiveness(lock, STALE * 10, STALE)).toBe("live");
    expect(livenessEvidence(lock).proven).toBe(true);
  });
});

// ============================================================================
// Arm 1 -- provably gone clears at ANY age
// ============================================================================
describe("#288 arm 1: a lock whose process is provably gone is clearable regardless of age", () => {
  // The 2026-08-02 case exactly: a lock two minutes old, far inside the 60-minute
  // window. On main this refuses with "a /z-loop is already running".
  test("a two-minute-old lock with a dead pid is acquired with --reconcile", () => {
    const d = tmp();
    const held = lockFile(d, { startedAt: 0, pid: 4242, startTime: "recorded-at-creation" });
    const nowMs = 2 * 60_000;
    // Sanity: the age heuristic alone would call this live, which is the wedge.
    expect(loopLockLiveness({ ...held, pid: undefined }, nowMs, STALE)).toBe("live");

    expect(loopLockLiveness(held, nowMs, STALE, () => false)).toBe("stale");
    const res = acquireLoopLock(
      d,
      { session: "fresh", startedAt: nowMs, host: HOST },
      { nowMs, stalenessMs: STALE, reconcile: true, isAlive: () => false }
    );
    expect(res.acquired).toBe(true);
    expect(readLoopLock(d)!.session).toBe("fresh");
  });

  test("a recycled pid is provably gone too, at any age", () => {
    const d = tmp();
    const held = lockFile(d, { pid: process.pid, startTime: "1999-01-01T00:00:00.0000000+00:00" });
    // The pid is genuinely alive (it is this process), but the OS start-time
    // recorded at creation no longer matches, so the integer was reused.
    expect(loopLockLiveness(held, 0, STALE)).toBe("stale");
    expect(livenessEvidence(held).proven).toBe(true);
    expect(livenessEvidence(held).evidence).toMatch(/reused that number/);
  });

  test("the evidence says which arm decided, so the refusal can quote it", () => {
    const gone = livenessEvidence({ session: "s", startedAt: 0, pid: 4242, host: HOST }, HOST, () => false);
    expect(gone.proven).toBe(true);
    expect(gone.evidence).toMatch(/process 4242 is gone/);
  });
});

// ============================================================================
// Arm 2 -- provably alive is NEVER cleared, at any age
// ============================================================================
describe("#288 arm 2: a lock whose process is provably alive is never cleared", () => {
  // #198's loss, made structurally impossible rather than merely unlikely: a real
  // drain that outlived the staleness window used to read stale, and the acquire
  // error sent the operator to --reconcile, which parked its tickets back to Ready
  // and deleted its running builders' worktrees.
  test("a ten-hour-old lock on a live, confirmed process still refuses --reconcile", () => {
    const d = tmp();
    const startTime = processStartTime(process.pid);
    expect(startTime).not.toBeNull();
    lockFile(d, { session: "long-drain", startedAt: 0, pid: process.pid, startTime: startTime! });
    const nowMs = 10 * 60 * 60_000; // 10h, far past the 60m window

    expect(loopLockLiveness(readLoopLock(d)!, nowMs, STALE)).toBe("live");
    const res = acquireLoopLock(
      d,
      { session: "intruder", startedAt: nowMs, host: HOST },
      { nowMs, stalenessMs: STALE, reconcile: true }
    );
    expect(res.acquired).toBe(false);
    expect(res.reason).toBe("live");
    expect(readLoopLock(d)!.session).toBe("long-drain"); // untouched
  });

  test("reconcile refuses against it too, and calls the reading proof", () => {
    const d = tmp();
    const startTime = processStartTime(process.pid)!;
    lockFile(d, { session: "long-drain", pid: process.pid, startTime });
    let caught: Error | undefined;
    try {
      assertNotReconcilingLiveLoop(d, 10 * 60 * 60_000, { lockStalenessMinutes: 60, slug: "proj" }, undefined);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/start-time still matches/);
    expect(caught!.message).toMatch(/That is proof, not a guess/);
    // ...and it STILL names the escape hatch, because proof that the harness
    // process is alive is not proof that the drain is executing. If the
    // orchestrator's turn died while Claude Code stayed open, the pid outlives the
    // loop and this reading never clears on its own -- where the age heuristic
    // used to give up after the staleness window. Hiding the way out is how the
    // 2026-08-02 "delete it by hand" ends up happening again.
    expect(caught!.message).toMatch(/force-release --slug "proj" --session "long-drain"/);
    expect(caught!.message).toMatch(/never clears on its own/);
  });

  // The distinction the message rests on, stated as a test so it cannot be
  // softened into "provably alive means untouchable": --reconcile must never
  // clear it by itself, but a deliberate force-release still can.
  test("proof blocks the AUTOMATIC clear, not the deliberate one", () => {
    const d = tmp();
    const startTime = processStartTime(process.pid)!;
    lockFile(d, { session: "wedged", pid: process.pid, startTime });
    const nowMs = 10 * 60 * 60_000;
    expect(
      acquireLoopLock(d, { session: "x", startedAt: nowMs, host: HOST }, { nowMs, stalenessMs: STALE, reconcile: true }).acquired
    ).toBe(false);
    // The session id alone is NOT enough while the process is provably alive: the
    // refusal that sends people here prints that id, and the orchestrator reads
    // that output too, so a blind paste must land on an explanation.
    const blind = forceReleaseLoopLock(d, "wedged");
    expect(blind.released).toBe(false);
    expect(blind.refusedBecause).toBe("provably-alive");
    expect(existsSync(loopLockPath(d))).toBe(true);
    // A human who knows the turn died says so deliberately.
    expect(forceReleaseLoopLock(d, "wedged", { allowLive: true }).released).toBe(true);
    expect(existsSync(loopLockPath(d))).toBe(false);
  });
});

// ============================================================================
// Arm 3 -- unprovable fails closed, with the exact command to run
// ============================================================================
describe("#288 arm 3: an unprovable lock fails closed and names the way out", () => {
  // No pid at all (an entrypoint that exports no CLAUDE_PID, or a lock written by
  // an older version), inside the staleness window. Nothing is cleared -- but the
  // operator is no longer left with "Stop that loop first" and nothing to stop.
  test("acquire refuses and prints the force-release line with the real session id", () => {
    const d = tmp();
    lockFile(d, { session: "mystery", startedAt: 0 });
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    let code: number;
    try {
      code = locksMain(["acquire", "--dir", d, "--session", "fresh", "--now", String(2 * 60_000), "--reconcile"]);
    } finally {
      console.error = realError;
    }
    expect(code).toBe(1);
    const said = errs.join("\n");
    expect(said).toContain("force-release");
    expect(said).toContain('--session "mystery"'); // the holder's id, ready to copy
    expect(said).toMatch(/NOT proof it is running/);
    expect(readLoopLock(d)!.session).toBe("mystery"); // fail closed: nothing cleared
  });

  test("reconcile's refusal carries the same command, with the slug", () => {
    const d = tmp();
    lockFile(d, { session: "mystery", startedAt: 0 });
    let caught: Error | undefined;
    try {
      assertNotReconcilingLiveLoop(d, 2 * 60_000, { lockStalenessMinutes: 60, slug: "myproj" }, undefined);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught!.message).toContain('force-release --slug "myproj" --session "mystery"');
    expect(caught!.message).toMatch(/records no process id/);
  });

  // Unprovable does not mean unclearable-forever: the age heuristic is still the
  // fallback, byte-for-byte as before, so nothing that used to recover stops.
  test("the age heuristic still clears an unprovable lock once it is old enough", () => {
    const d = tmp();
    lockFile(d, { session: "mystery", startedAt: 0 });
    const nowMs = STALE + 1;
    const res = acquireLoopLock(d, { session: "fresh", startedAt: nowMs, host: HOST }, { nowMs, stalenessMs: STALE, reconcile: true });
    expect(res.acquired).toBe(true);
  });

  // Turning the pid arm on exposed this: before #288 no production lock carried a
  // pid, so "dead pid -> stale, host regardless" was unreachable. With every lock
  // carrying one, a pid that is not alive HERE would have been read as proof that
  // ANOTHER machine's loop is dead -- and --reconcile would park its tickets and
  // delete its worktrees. #198's loss, reached across machines.
  test("a foreign-host lock is unprovable, even with a pid that is dead on this host", () => {
    const foreign: LoopLock = { session: "other-machine", startedAt: 0, pid: 4242, host: "some-other-host", startTime: "x" };
    expect(loopLockLiveness(foreign, 0, STALE, () => false)).toBe("live"); // NOT cleared on a meaningless pid
    expect(loopLockLiveness(foreign, STALE + 1, STALE, () => false)).toBe("stale"); // age still recovers it
    const ev = livenessEvidence(foreign, HOST, () => false);
    expect(ev.proven).toBe(false);
    expect(ev.evidence).toMatch(/not this one/);
  });
});

// ============================================================================
// The escape hatch itself
// ============================================================================
describe("#288: force-release is scoped, confirmed, and idempotent", () => {
  test("the wrong session id refuses and leaves the lock alone", () => {
    const d = tmp();
    lockFile(d, { session: "A" });
    expect(forceReleaseLoopLock(d, "B").released).toBe(false);
    expect(readLoopLock(d)!.session).toBe("A");

    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    let code: number;
    try {
      code = locksMain(["force-release", "--dir", d, "--session", "B"]);
    } finally {
      console.error = realError;
    }
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain('held by session "A"'); // names the real holder
    expect(existsSync(loopLockPath(d))).toBe(true);
  });

  test("the right session id clears the lock and its beat, and NOTHING else", () => {
    const d = tmp();
    lockFile(d, { session: "A" });
    writeFileSync(heartbeatPath(d), JSON.stringify({ session: "A", lastSeenAt: 0 }) + "\n");
    // The things that must survive: lane locks and worktree records are
    // reconcile's business, not this command's.
    writeLaneLock(d, { ticket: 7, stage: "builder", session: "A", claimedAt: 0 });
    writeFileSync(join(d, "worktree-7.json"), JSON.stringify({ ticket: 7, disposition: "retained", session: "A", writtenAt: 0 }));

    expect(locksMain(["force-release", "--dir", d, "--session", "A"])).toBe(0);
    expect(existsSync(loopLockPath(d))).toBe(false);
    expect(existsSync(heartbeatPath(d))).toBe(false);
    expect(existsSync(join(d, "ticket-7.json"))).toBe(true);
    expect(existsSync(join(d, "worktree-7.json"))).toBe(true);
  });

  test("releasing a lock that is already gone is a success, not an error", () => {
    const d = tmp();
    expect(forceReleaseLoopLock(d, "anything").released).toBe(true);
    expect(locksMain(["force-release", "--dir", d, "--session", "anything"])).toBe(0);
  });

  // Force-releasing a PROVEN-live lock is possible -- the operator may know
  // something the machine does not -- but it must not be quiet about it.
  test("the CLI refuses a provably-live lock until --even-if-running is passed", () => {
    const d = tmp();
    lockFile(d, { session: "A", pid: process.pid, startTime: processStartTime(process.pid)! });

    // A blind paste of the command the acquire refusal prints.
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    let code: number;
    try {
      code = locksMain(["force-release", "--dir", d, "--session", "A"]);
    } finally {
      console.error = realError;
    }
    expect(code).toBe(1);
    expect(existsSync(loopLockPath(d))).toBe(true); // the running loop keeps its lock
    expect(errs.join("\n")).toMatch(/PROOF the process holding/);
    expect(errs.join("\n")).toMatch(/--even-if-running/);
    expect(errs.join("\n")).toMatch(/#198/); // names what it would cost

    // The deliberate form goes through, and says what it just did.
    const said: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    try {
      expect(locksMain(["force-release", "--dir", d, "--session", "A", "--even-if-running"])).toBe(0);
    } finally {
      console.log = realLog;
    }
    expect(said.join("\n")).toMatch(/PROVABLY ALIVE/);
    expect(said.join("\n")).toMatch(/reconcile apply/); // the lanes are still someone's job
  });

  // The acquire refusal must print the UN-flagged command, so pasting it hits the
  // refusal above rather than clearing a running loop's lock.
  test("the acquire refusal never prints a paste-and-go command for a live loop", () => {
    const d = tmp();
    lockFile(d, { session: "long-drain", pid: process.pid, startTime: processStartTime(process.pid)! });
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    try {
      locksMain(["acquire", "--dir", d, "--session", "fresh", "--now", String(STALE * 10), "--reconcile"]);
    } finally {
      console.error = realError;
    }
    const said = errs.join("\n");
    expect(said).toMatch(/force-release/); // still discoverable
    expect(said).not.toMatch(/--even-if-running/); // ...but not ready to run
  });

  // The other half of the same rule, and the bug it was hiding: "proven" covered
  // proven-DEAD too, so clearing a lock whose process was gone warned the operator
  // to go make sure that loop was stopped -- about a process the same sentence had
  // just called gone. The warning is gated on the arm, not on provenness.
  test("clearing a lock whose process is GONE carries no still-running warning", () => {
    const d = tmp();
    lockFile(d, { session: "A", pid: 999999, startTime: "recorded-at-creation" });
    expect(livenessEvidence(readLoopLock(d)!).arm).toBe("gone");
    const said: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    try {
      expect(locksMain(["force-release", "--dir", d, "--session", "A"])).toBe(0);
    } finally {
      console.log = realLog;
    }
    expect(said.join("\n")).toMatch(/process 999999 is gone/);
    expect(said.join("\n")).not.toMatch(/make sure that loop really is stopped/);
  });
});

// ============================================================================
// The acquire path records it, so none of the above depends on prose
// ============================================================================
describe("#288: acquire records the harness pid without being told to", () => {
  test.skipIf(harnessPid() === undefined)("a plain acquire under Claude Code stores pid + host + start-time", () => {
    const pid = harnessPid()!;
    const d = tmp();
    expect(locksMain(["acquire", "--dir", d, "--session", "s", "--now", "0"])).toBe(0);
    const lock = JSON.parse(readFileSync(loopLockPath(d), "utf8")) as LoopLock;
    expect(lock.pid).toBe(pid);
    expect(lock.host).toBe(HOST);
    expect(lock.startTime).toBeDefined();
    // ...and that lock reads live past the staleness window, by proof.
    expect(loopLockLiveness(lock, STALE * 10, STALE)).toBe("live");
  });

  test("--pid still overrides, so the gate tests are not at the mercy of the harness", () => {
    const d = tmp();
    expect(locksMain(["acquire", "--dir", d, "--session", "s", "--pid", "4242", "--now", "0"])).toBe(0);
    expect(JSON.parse(readFileSync(loopLockPath(d), "utf8")).pid).toBe(4242);
  });
});

// ============================================================================
// #288 review findings — regressions this diff introduced, pinned
// ============================================================================
describe("#288 review: a malformed pid must never read as a dead one", () => {
  // JSON.stringify turns NaN into null, so a garbage `--pid` wrote `"pid": null`
  // to disk. null is not undefined, so it reached the pid arm, where
  // processAlive(null) is false -- and a BRAND-NEW, actively-draining loop's lock
  // read `stale` at age zero. That is the catastrophic direction: --reconcile then
  // parks its tickets and force-deletes its worktrees. Same class as M19's NaN.
  test("acquire rejects a non-positive-integer --pid instead of writing null", () => {
    const d = tmp();
    for (const bad of ["abc", "0", "-1", "12.5", ""]) {
      expect(locksMain(["acquire", "--dir", d, "--session", "s", "--pid", bad, "--now", "0"])).toBe(1);
      expect(existsSync(loopLockPath(d))).toBe(false); // nothing written
    }
  });

  test("a lock on disk carrying a malformed pid fails loud, never 'stale'", () => {
    const d = tmp();
    for (const bad of [null, "4242", -1, 0, 12.5]) {
      writeFileSync(loopLockPath(d), JSON.stringify({ session: "live-drain", startedAt: 0, host: HOST, pid: bad }));
      expect(() => readLoopLock(d)).toThrow(/malformed pid/);
      // ...and the acquire path refuses rather than clobbering a live loop's lock.
      expect(() =>
        acquireLoopLock(d, { session: "x", startedAt: 0, host: HOST }, { nowMs: 0, stalenessMs: STALE, reconcile: true })
      ).toThrow(/malformed pid/);
    }
  });
});

describe("#288 review: the host gate and the identity check agree by construction", () => {
  // The gate used the injected host while the default identify re-derived the real
  // hostname(), so injecting a host made the "confirmed" arm structurally
  // unreachable -- a test of the arm this ticket turns on could not fail.
  test("an injected host reaches the confirmed arm instead of falling through to age", () => {
    const startTime = processStartTime(process.pid)!;
    const lock: LoopLock = { session: "s", startedAt: 0, pid: process.pid, host: "fixture-host", startTime };
    // Past the staleness window: only the pid arm can return "live" here.
    expect(loopLockLiveness(lock, STALE * 10, STALE, undefined, undefined, undefined, "fixture-host")).toBe("live");
    expect(livenessEvidence(lock, "fixture-host").arm).toBe("alive");
    // ...and a host that does NOT match still refuses to read the pid.
    expect(loopLockLiveness(lock, STALE * 10, STALE, () => false, undefined, undefined, "other-host")).toBe("stale");
    expect(livenessEvidence(lock, "other-host").arm).toBe("unprovable");
  });
});

describe("#288 review: force-release does not clobber a lock that changed under it", () => {
  test("a holder that is replaced between the read and the unlink is refused, not deleted", () => {
    const d = tmp();
    lockFile(d, { session: "A" });
    // Simulate the racer: the same call re-reads before unlinking, so a lock that
    // is no longer A's is left alone rather than removed by path.
    const originalRead = readLoopLock(d);
    expect(originalRead!.session).toBe("A");
    writeFileSync(loopLockPath(d), JSON.stringify({ session: "B-fresh", startedAt: 1, host: HOST }));
    const res = forceReleaseLoopLock(d, "A");
    expect(res.released).toBe(false);
    expect(res.held!.session).toBe("B-fresh");
    expect(existsSync(loopLockPath(d))).toBe(true); // B's live lock survived
  });
});
