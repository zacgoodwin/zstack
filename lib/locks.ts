// The C7 lockfile layer for /z-loop (issue #2): the on-disk claims a running
// loop leaves so a crash/restart or a second concurrent invocation is detectable.
// Two kinds of lock live under `~/.zstack/projects/<slug>/locks/`:
//
//   * Lane locks  `ticket-<N>.json` {ticket, stage, session, claimedAt} -- one
//     per in-flight lane, written at claim, re-stamped on every stage
//     transition, removed at lane end. Atomic (tmp + rename) so a reader never
//     sees a half-written lock. `claimedAt` doubles as the lane's last-touched
//     time, so a stale lock is legible after a crash.
//   * Worktree records `worktree-<N>.json` {ticket, disposition, session,
//     writtenAt} -- what a lane-terminating action MEANT to leave behind (issue
//     #271). Written beside the lane locks, same atomic write, and read by
//     lib/reconcile.ts's orphan scan.
//   * Loop lock   `loop.lock` {session, startedAt, pid?} -- one per project. A
//     second /z-loop on the same project reads it and refuses to start, naming
//     the live session. Liveness: a verifiable pid decides (see harnessPid --
//     since #288 that pid is recorded in production, so this is the arm that
//     actually runs); with no verifiable pid, a lock older than the configured
//     staleness threshold is judged stale (crashed) rather than live, so a dead
//     loop never wedges the next run. The one-shot
//     `loop.lock.reconcile` claim that serializes --reconcile's clear-and-replace
//     carries the same payload and gets the same judgment, so a claim orphaned by a
//     crash inside the claimed section self-heals too: the next run supersedes it with
//     the next generation (`loop.lock.reconcile.1`, `.2`, ...) (issue #144).
//
// Same discipline as lib/setup-permissions.ts: EVERY path is a parameter here.
// Only main() computes the real ~/.zstack directory, so every test in
// tests/safety.test.ts is structurally incapable of touching a real lock.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWrite, handleCliError, parseFlags, requireFlag, str } from "./cli.ts";
import {
  DEFAULT_LOCK_STALENESS_MINUTES,
  ZError,
  loadConfig,
  projectsDir,
} from "./config.ts";
import type { Stage } from "./loop.ts";

// -- shapes -------------------------------------------------------------------

export interface LaneLock {
  ticket: number;
  stage: Stage;
  session: string;
  claimedAt: number; // ms; set at claim, re-stamped on each stage transition
}

export interface LoopLock {
  session: string;
  startedAt: number; // ms
  pid?: number; // best-effort; when present AND its identity is confirmable it decides liveness
  host?: string; // the machine that wrote the lock; a foreign host makes the pid unverifiable
  startTime?: string; // the pid's OS process-start-time at lock creation; a mismatch on read proves pid reuse
}

export type LockLiveness = "live" | "stale";

// -- paths (always injected; main() is the only default) ----------------------

// The locks directory for a slug under a home. Used ONLY by main(); every other
// function takes an already-resolved locksDir.
export function defaultLocksDir(slug: string, home = homedir()): string {
  return join(projectsDir(home), slug, "locks");
}

export function laneLockPath(locksDir: string, ticket: number): string {
  return join(locksDir, `ticket-${ticket}.json`);
}

export function loopLockPath(locksDir: string): string {
  return join(locksDir, "loop.lock");
}

// The liveness heartbeat (issue #198), a SIDECAR beside the loop lock rather
// than a field inside it. loop.lock is written with an exclusive create and must
// stay that way -- that create IS the H11 mutual-exclusion guarantee -- so the
// "is this loop still alive" signal cannot live in the same file. A separate
// file also makes two hazards structurally impossible rather than merely
// guarded: a straggler beat can never RESURRECT a released lock (writing the
// beat never creates a lock), and a beat can never STOMP a reconciler's
// replacement (the beat carries its session and a mismatch is ignored).
//
// Name safety: currentClaimGen prefix-matches `loop.lock.reconcile`, which this
// does not match, and listLaneLocks filters /^ticket-\d+\.json$/.
export function heartbeatPath(locksDir: string): string {
  return join(locksDir, "loop.lock.beat");
}

// -- lane locks ---------------------------------------------------------------
// Writes go through lib/cli.ts atomicWrite (tmp + rename, mode 0o600) so a
// concurrent reader never observes a half-written or world-readable lock.

// Written at claim and re-stamped on every stage transition (`claimedAt` set to
// nowMs each time), so the lock's age tracks the lane's liveness after a crash.
export function writeLaneLock(locksDir: string, lock: LaneLock): void {
  atomicWrite(laneLockPath(locksDir, lock.ticket), JSON.stringify(lock, null, 2) + "\n");
}

export function readLaneLock(locksDir: string, ticket: number): LaneLock | null {
  const path = laneLockPath(locksDir, ticket);
  if (!existsSync(path)) return null;
  return parseLaneLock(path);
}

export function removeLaneLock(locksDir: string, ticket: number): void {
  rmSync(laneLockPath(locksDir, ticket), { force: true });
}

// Every lane lock currently on disk, with its path, sorted by ticket. Tolerates
// a missing locks dir (returns []) -- a fresh project has none. Only ENOENT
// means "no lanes": any other readdir failure (ENOTDIR: the path is a file;
// EACCES/EPERM: unreadable) must not render a plausible-but-false idle
// dashboard -- fail loud, naming the path (F13).
export function listLaneLocks(locksDir: string): { path: string; lock: LaneLock }[] {
  let names: string[];
  try {
    names = readdirSync(locksDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw new ZError(`Cannot read locks dir ${locksDir}: ${e?.message ?? e}`);
  }
  const out: { path: string; lock: LaneLock }[] = [];
  for (const name of names) {
    if (!/^ticket-\d+\.json$/.test(name)) continue;
    const path = join(locksDir, name);
    out.push({ path, lock: parseLaneLock(path) });
  }
  return out.sort((a, b) => a.lock.ticket - b.lock.ticket);
}

function parseLaneLock(path: string): LaneLock {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Lane lock ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const l = raw as any;
  if (typeof l?.ticket !== "number" || typeof l?.stage !== "string" || typeof l?.session !== "string" || typeof l?.claimedAt !== "number") {
    throw new ZError(`Lane lock ${path} must be {ticket, stage, session, claimedAt}.`);
  }
  return l as LaneLock;
}

// -- worktree disposition records (issue #271) ---------------------------------
//
// Before this, `lib/reconcile.ts` classified a lane worktree by ONE fact: does a
// lane lock exist for its ticket? Everything else was an orphan, force-pruned by
// the next `--reconcile`. But three of the four lane-terminating actions
// deliberately keep their worktree AND drop their lock -- `park N Questions`,
// `skip N`, and `stop-lane N` all say "keep the worktree for inspection"
// (z-loop/SKILL.md). So the moment a lane parked, the worktree it kept on purpose
// became an orphan by definition: the next run refused to start ("Orphans
// present") and the `--reconcile` it demanded deleted exactly what the park was
// saving.
//
// Lock-absence cannot distinguish those from a crash, because it is the same
// observation. So the intent is RECORDED instead of inferred:
//
//   * `retained`   -- a human-facing park/skip/stop-lane kept this worktree as
//                     the artifact. Never an orphan, never auto-pruned.
//   * `disposable` -- the salvage parks (#177's commit-retry, #209's dead-worker
//                     respawn) dumped a patch first precisely BECAUSE their
//                     worktree is meant to die. Behaves exactly like a crash.
//
// A worktree with NO record is a genuine crash and keeps today's behavior
// byte-for-byte -- which is what makes this safe to add: absence of a record is
// never read as permission to keep something.
//
// There is deliberately no `active` value. A lane that is still running has a
// LANE LOCK, and that is already the stronger fact reconcile checks first; a
// third value would be a second source of truth for the same question.
export type WorktreeDisposition = "retained" | "disposable";

export interface WorktreeRecord {
  ticket: number;
  disposition: WorktreeDisposition;
  session: string;
  writtenAt: number; // ms, injected clock
}

// Name safety, same discipline as heartbeatPath: `worktree-<N>.json` matches
// neither listLaneLocks's /^ticket-\d+\.json$/ nor currentClaimGen's
// `loop.lock.reconcile` prefix scan, so the three kinds of file in this directory
// can never be read as one another.
//
// The ticket is validated HERE, in the one place a number becomes a filename, so
// the writer and the remover cannot disagree with the reader. `Number.isInteger`
// alone was not enough: it admits 0, negatives and exponential forms, and
// `worktree--5.json` / `worktree-1e+21.json` do not match listWorktreeRecords's
// /^worktree-\d+\.json$/. A record that is written but can never be read back is
// the worst possible failure for this file -- "retained" degrades to "no record",
// which means "a crash", which force-prunes the worktree a human parked.
export function worktreeRecordPath(locksDir: string, ticket: number): string {
  if (!Number.isInteger(ticket) || ticket <= 0 || !/^\d+$/.test(String(ticket))) {
    throw new ZError(`Worktree record ticket must be a positive integer, got "${ticket}".`);
  }
  return join(locksDir, `worktree-${ticket}.json`);
}

export function writeWorktreeRecord(locksDir: string, rec: WorktreeRecord): void {
  mkdirSync(locksDir, { recursive: true });
  atomicWrite(worktreeRecordPath(locksDir, rec.ticket), JSON.stringify(rec, null, 2) + "\n");
}

export function removeWorktreeRecord(locksDir: string, ticket: number): void {
  rmSync(worktreeRecordPath(locksDir, ticket), { force: true });
}

// Every worktree record on disk, sorted by ticket. Tolerates a missing dir like
// listLaneLocks does, and for the same reason.
//
// Fails LOUD on a corrupt record, deliberately -- the alternative is to skip it,
// which reads as "no record", which reads as "a crash", which force-prunes a
// worktree a human parked. A record that cannot be parsed must stop the scan, not
// resolve to the destructive answer.
export function listWorktreeRecords(locksDir: string): { path: string; record: WorktreeRecord }[] {
  let names: string[];
  try {
    names = readdirSync(locksDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw new ZError(`Cannot read locks dir ${locksDir}: ${e?.message ?? e}`);
  }
  const out: { path: string; record: WorktreeRecord }[] = [];
  for (const name of names) {
    if (!/^worktree-\d+\.json$/.test(name)) continue;
    const path = join(locksDir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ZError(`Worktree record ${path} is not valid JSON: ${(e as Error).message}`);
    }
    const r = raw as any;
    if (
      typeof r?.ticket !== "number" ||
      (r?.disposition !== "retained" && r?.disposition !== "disposable") ||
      typeof r?.session !== "string" ||
      typeof r?.writtenAt !== "number"
    ) {
      throw new ZError(
        `Worktree record ${path} must be {ticket, disposition: "retained"|"disposable", session, writtenAt}.`
      );
    }
    out.push({ path, record: r as WorktreeRecord });
  }
  return out.sort((a, b) => a.record.ticket - b.record.ticket);
}

// -- loop lock ----------------------------------------------------------------

export function readLoopLock(locksDir: string): LoopLock | null {
  const path = loopLockPath(locksDir);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Loop lock ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const l = raw as any;
  if (typeof l?.session !== "string" || typeof l?.startedAt !== "number") {
    throw new ZError(`Loop lock ${path} must be {session, startedAt, pid?}.`);
  }
  // A malformed pid must NEVER read as "a pid that is not alive" (#288 review).
  // JSON.stringify turns NaN into null, so a garbage `--pid` writes `"pid": null`
  // -- and null is not undefined, so it reached the pid arm, where
  // processAlive(null) is false and the lock read STALE at age zero. That is the
  // catastrophic direction: a brand-new, actively-draining loop's lock becomes
  // clearable, and --reconcile then parks its tickets and force-deletes its
  // worktrees. Fail loud instead, the same call M19 made for --staleness-minutes.
  if (l.pid !== undefined && !(Number.isInteger(l.pid) && l.pid > 0)) {
    throw new ZError(
      `Loop lock ${path} has a malformed pid ${JSON.stringify(l.pid)}: it must be a positive integer when present. ` +
        `Refusing to judge liveness from it -- a pid that cannot be read is not a pid that is dead.`
    );
  }
  return l as LoopLock;
}

// -- liveness heartbeat (issue #198) ------------------------------------------

export interface Heartbeat {
  session: string; // the loop that stamped it; a mismatch with the lock is ignored
  lastSeenAt: number; // ms, injected clock
}

// Deliberately TOLERANT where readLoopLock is fail-loud: a misread lock risks
// two loops on one board, whereas a misread beat can only make us judge the
// loop MORE conservatively (fall back to startedAt, i.e. today's behavior). A
// corrupt beat must never wedge an acquire.
export function readHeartbeat(locksDir: string): Heartbeat | null {
  const path = heartbeatPath(locksDir);
  if (!existsSync(path)) return null;
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as any;
    if (typeof b?.session !== "string" || typeof b?.lastSeenAt !== "number") return null;
    return b as Heartbeat;
  } catch {
    return null;
  }
}

// Stamp the beat -- read-verify-write, and NEVER create. Returns what it did so
// the caller can surface "foreign" (our loop was reconciled out from under us),
// which is alarming but must not abort a tick with lanes in flight.
export function writeHeartbeat(
  locksDir: string,
  session: string,
  nowMs: number
): "stamped" | "not-held" | "foreign" {
  const lock = readLoopLock(locksDir);
  if (!lock) return "not-held";
  if (lock.session !== session) return "foreign";
  atomicWrite(heartbeatPath(locksDir), JSON.stringify({ session, lastSeenAt: nowMs }) + "\n");
  return "stamped";
}

// The anchor liveness measures age against. A beat from a DIFFERENT session
// means a reconciler replaced the lock while that beat was in flight; the new
// holder's own startedAt is fresh and decides, so the stale beat is ignored.
// Math.max defends against a beat older than startedAt (clock skew, or a beat
// left by a prior run of the same session name).
export function effectiveLastSeen(lock: LoopLock, beat: Heartbeat | null): number {
  return beat && beat.session === lock.session
    ? Math.max(lock.startedAt, beat.lastSeenAt)
    : lock.startedAt;
}

// The process whose death IS the loop's death (issue #288).
//
// /z-loop is an AGENT, not a daemon -- "no daemon" is the design -- so for a long
// time the pack had no pid worth recording and `loopLockLiveness`'s pid arm never
// ran in production. The comment further down said so outright. The consequence
// was the wedge #288 exists for: with only the age heuristic left, a loop that
// died five minutes ago read LIVE for the rest of `lockStalenessMinutes` (default
// 60), `acquireLoopLock` refuses a live lock even with --reconcile (on purpose --
// never nuke a running loop), `assertNotReconcilingLiveLoop` refuses too (on
// purpose, #198), and the only way out was `rm loop.lock` by hand. That happened
// on 2026-08-02.
//
// #164 rejected the obvious candidate and was right to: the SKILL step's `$$` is
// the Bash tool's SHELL, which exits the moment the acquire command returns, so a
// lock carrying it would read dead instantly. But the shell is not the only
// ancestor. Claude Code exports `CLAUDE_PID` into every tool process, and it names
// the harness process that owns the session -- verified by walking the ancestor
// chain from a tool call on this machine: the immediate parent is `claude.exe`
// and its pid is exactly `CLAUDE_PID`. That process's lifetime IS the drain's
// lifetime: while it lives the session can still be executing the loop, and when
// it dies -- crash, close, kill -- nothing is left that could still be draining.
//
// So this is the whole of #288's fix. No new liveness mechanism: the pid arm
// below (dead pid -> stale at any age; alive + start-time confirmed -> live at any
// age; recycled -> stale) was already written and gate-tested for issue #14 H12
// and has simply never had a pid to run on.
//
// Absent or unparseable -> undefined -> the lock records no pid -> the age
// heuristic decides, exactly as before. Every entrypoint that does not export the
// variable degrades to today's behavior rather than to a wrong answer.
export function harnessPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.CLAUDE_PID;
  if (raw === undefined) return undefined;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Is the process holding a loop lock alive on THIS host? signal 0 checks
// existence: EPERM means it exists but is another user's (alive); ESRCH / any
// other error means gone. Only meaningful when the lock was written on THIS host
// (see confirmIdentity) -- a pid alive here says nothing about a lock from another
// machine, and the same integer may have been recycled to an unrelated process.
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// The OS process-start-time of a pid, as an opaque string, or null when the pid is
// gone / the value can't be read. Paired with the pid it disambiguates a RECYCLED
// pid (issue #14 H12): the OS never assigns the same (pid, start-time) to two
// processes, so a stored start-time that no longer matches the live pid's proves the
// integer was reused. No Node/Bun API exposes another process's start-time, so this
// shells out -- guarded to null so a failed probe degrades to the staleness-age
// heuristic rather than throwing. ponytail: one spawn per liveness check on the
// pid path; upgrade path is a native binding, not worth it for a solo-dev tool.
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const cmd =
      process.platform === "win32"
        ? [
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            // -ErrorAction SilentlyContinue => no such pid prints nothing (stdout empty -> null).
            // ToString('o') is round-trippable and stable for a fixed process, so two reads match.
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToString('o') }`,
          ]
        : ["ps", "-o", "lstart=", "-p", String(pid)]; // lstart: full start timestamp, empty when gone
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Can we trust this lock's pid as "our loop's pid" on this machine? Only when the
// lock records the SAME host we're running on. A foreign host (or a host-less
// legacy lock) is unconfirmable: process.kill would probe THIS host's pid space,
// so a coincidentally-live local pid would falsely read the foreign lock as live.
export function sameHost(lock: LoopLock, host: string = hostname()): boolean {
  return lock.host !== undefined && lock.host === host;
}

export type IdentityCheck = "confirmed" | "recycled" | "unknown";

// Three-valued pid-identity check for the SAME host (issue #14 H12). A pid alive on
// this host is trusted as OUR loop ONLY when its current OS start-time matches the
// one stored at lock creation:
//   * "confirmed" -- start-times match: the pid is still our loop.
//   * "recycled"  -- start-times differ: the OS handed this pid to an unrelated
//     process, so the lock is stale and --reconcile may clear it. THIS is the case
//     the pre-fix code got wrong -- it read such a lock "live forever".
//   * "unknown"   -- foreign/legacy host, a legacy lock carrying no start-time, or
//     the probe couldn't read the live pid's start-time: the caller must fall back
//     to the staleness-age heuristic rather than guess. Host + start-time probe are
//     injected so tests need neither a real hostname nor a shell-out.
export function confirmIdentity(
  lock: LoopLock,
  host: string = hostname(),
  startTimeOf: (pid: number) => string | null = processStartTime
): IdentityCheck {
  if (!sameHost(lock, host)) return "unknown"; // foreign/legacy host: pid unattributable
  if (lock.pid === undefined || lock.startTime === undefined) return "unknown"; // legacy lock
  const current = startTimeOf(lock.pid);
  if (current === null) return "unknown"; // couldn't read it -> don't guess
  return current === lock.startTime ? "confirmed" : "recycled";
}

// Liveness with pid-reuse safety (issue #14 H12). A present pid decides ONLY when its
// identity is provable:
//   * dead pid          -> "stale" immediately (a crashed loop recovers without
//                          waiting out the staleness window).
//   * alive + confirmed -> "live" (same host AND the OS start-time still matches the
//                          one stored at lock creation: provably our loop).
//   * alive + recycled  -> "stale" (same host, but the pid was reused by an unrelated
//                          process -- never "live forever" on the same host again).
//   * alive + unknown   -> fall through to the age heuristic (foreign host, a legacy
//                          lock with no start-time, or an unreadable start-time), so
//                          --reconcile can still clear a genuinely stale lock.
// Clock, liveness probe, and identity check are all injected for deterministic tests.
export function loopLockLiveness(
  lock: LoopLock,
  nowMs: number,
  stalenessMs: number,
  isAlive: (pid: number) => boolean = processAlive,
  // #288 review: `host` is threaded IN, so the gate below and this check can never
  // disagree about which machine they are on. The old default re-derived
  // hostname() internally, so a caller injecting `host` got a split brain -- the
  // gate passed on the injected host while confirmIdentity answered "unknown" for
  // the real one, silently falling through to the age heuristic. That made an
  // injected-host test of the "confirmed" path structurally unable to fail, which
  // is precisely the arm this ticket turns on in production.
  identify: (lock: LoopLock, host: string) => IdentityCheck = (l, h) => confirmIdentity(l, h),
  // issue #198: the anchor to measure age from. Callers holding a locksDir pass
  // effectiveLastSeen(lock, readHeartbeat(dir)); omitting it falls back to
  // startedAt, which is exactly the pre-#198 behavior -- so every existing
  // positional call site keeps its meaning.
  lastSeenAt?: number,
  // #288: the host the pid arm is being evaluated ON. Injected for the gate tests;
  // production takes this machine's hostname.
  host: string = hostname()
): LockLiveness {
  // The whole pid arm is gated on the lock having been written by THIS host.
  //
  // Before #288 the dead-pid branch ran host-regardless, and that was harmless
  // only because production recorded no pid at all -- the branch was unreachable.
  // Now that every lock carries the harness pid, "pid 41644 is not alive here"
  // would be read as proof that ANOTHER machine's loop is dead, and --reconcile
  // would park its tickets and delete its worktrees: #198's exact loss, reached
  // across machines. A pid integer means nothing off the host that assigned it,
  // which is what processAlive's own comment has always said; only the branch
  // failed to honour it. A foreign lock now falls to the age heuristic, the same
  // answer it already gave for a foreign lock whose pid happened to be alive.
  if (lock.pid !== undefined && sameHost(lock, host)) {
    if (!isAlive(lock.pid)) return "stale"; // dead pid: our loop is definitely gone
    switch (identify(lock, host)) {
      case "confirmed":
        return "live"; // alive AND provably ours (start-time matches)
      case "recycled":
        return "stale"; // alive but the pid was reused by an unrelated process
      case "unknown":
        break; // unconfirmable: fall through to the age heuristic
    }
  }
  // A pid, when present and confirmable, outranks the heartbeat above. Since #288
  // production DOES record one (harnessPid), so this age branch is now the
  // fallback for the unprovable cases -- a foreign host, a legacy lock with no
  // start-time, an entrypoint that exports no CLAUDE_PID -- rather than the only
  // branch ever reached. It is still the branch whose un-refreshed anchor made
  // every long drain read stale (#198), which is why the heartbeat feeds it.
  return nowMs - (lastSeenAt ?? lock.startedAt) > stalenessMs ? "stale" : "live";
}

// Which arm decided, in words, for the refusal messages (#288). The operator's
// next move depends entirely on this: a PROVEN reading is worth trusting, while
// an unprovable one is a guess from age that they may need to override.
// Which arm decided is returned explicitly, not folded into a boolean (#288
// review). `proven` conflated "proven ALIVE" with "proven DEAD", so
// force-releasing a lock whose process was GONE printed "that reading was PROVEN,
// so make sure that loop really is stopped" -- telling the operator to go hunt a
// process the same sentence had just called gone. Only `arm === "alive"` should
// ever gate an is-it-still-running warning.
export type LivenessArm = "alive" | "gone" | "recycled" | "unprovable";

export function livenessEvidence(
  lock: LoopLock,
  host: string = hostname(),
  isAlive: (pid: number) => boolean = processAlive,
  identify: (l: LoopLock, h: string) => IdentityCheck = (l, h) => confirmIdentity(l, h)
): { arm: LivenessArm; proven: boolean; evidence: string } {
  const unprovable = (evidence: string) => ({ arm: "unprovable" as const, proven: false, evidence });
  if (lock.pid === undefined) {
    return unprovable(`the lock records no process id, so only its age is legible`);
  }
  if (!sameHost(lock, host)) {
    return unprovable(
      `the lock was written on host "${lock.host ?? "(unrecorded)"}", not this one, so its pid ${lock.pid} proves nothing here`
    );
  }
  if (!isAlive(lock.pid)) return { arm: "gone", proven: true, evidence: `process ${lock.pid} is gone` };
  switch (identify(lock, host)) {
    case "confirmed":
      return {
        arm: "alive",
        proven: true,
        evidence: `process ${lock.pid} is alive and its OS start-time still matches the one recorded at lock creation`,
      };
    case "recycled":
      return {
        arm: "recycled",
        proven: true,
        evidence: `process ${lock.pid} is alive but the OS reused that number for an unrelated process`,
      };
    default:
      return unprovable(
        `process ${lock.pid}'s identity could not be confirmed (no recorded start-time, or it could not be read), so only the lock's age is legible`
      );
  }
}

// The one command that clears a loop lock nobody can prove anything about
// (#288). Deliberately NOT part of --reconcile: reconcile acts on evidence, and
// this is the verb for when there is none. Requires the holder's EXACT session id
// as a confirmation token, so a copy-pasted command cannot clear a lock the
// operator never looked at, and touches ONLY the loop lock and its beat -- lane
// locks, worktree records and worktrees stay reconcile's business.
export function forceReleaseLoopLock(
  locksDir: string,
  session: string,
  opts: { allowLive?: boolean; host?: string } = {}
): { released: boolean; held?: LoopLock; refusedBecause?: "session-mismatch" | "provably-alive" } {
  const lock = readLoopLock(locksDir);
  if (!lock) return { released: true }; // already gone: idempotent, not an error
  if (lock.session !== session) return { released: false, held: lock, refusedBecause: "session-mismatch" };
  // The session id was supposed to be the confirmation token -- "a pasted command
  // cannot clear a lock the operator never looked at" -- but the refusal that
  // sends people here PRINTS that id, so the token proves nothing on its own
  // (#288 review). And z-loop/SKILL.md Step 0 tells the orchestrator to read that
  // output, so an AGENT can follow the printed advice. Clearing a provably-alive
  // loop's lock lets a second loop start and lets `reconcile apply` park the live
  // run's tickets and force-delete its worktrees: #198's exact loss.
  //
  // So when the process is PROVABLY alive, the id is not enough -- a second,
  // deliberate flag is required. The refusal message for that case deliberately
  // prints the command WITHOUT the flag, so a blind copy-paste lands here and is
  // explained rather than executed. Every other arm (gone, recycled, unprovable)
  // is unchanged: nothing is proven to be running, so the id alone is the gate.
  if (!opts.allowLive && livenessEvidence(lock, opts.host ?? hostname()).arm === "alive") {
    return { released: false, held: lock, refusedBecause: "provably-alive" };
  }
  // Re-read immediately before the unlink (#288 review). This is a read-then-
  // unlink-by-path, and the named holder can release while a DIFFERENT loop wins
  // the exclusive create in the gap -- the rmSync would then delete the new, live
  // loop's lock and leave the board unguarded. Operators run this exactly when a
  // loop is thrashing, so the window is not hypothetical. Re-checking does not
  // close it (there is no compare-and-delete on either platform), but it shrinks
  // it to the syscall gap and makes the common restart-in-between case refuse
  // instead of clobber. A residual instant remains: this is the deliberate
  // break-glass verb, and callers are told to stop the loop first.
  const still = readLoopLock(locksDir);
  if (!still) return { released: true };
  if (still.session !== session) return { released: false, held: still };
  releaseLoopLock(locksDir);
  return { released: true, held: still };
}

export interface LoopLockState {
  state: "free" | "live" | "stale";
  lock?: LoopLock; // the existing lock, when state is live or stale
  lastSeenAt?: number; // #198: the anchor age was judged against (beat, else startedAt)
}

// The one function that owns a locksDir, so the one place the lock and its
// sidecar beat are merged (#198).
export function inspectLoopLock(
  locksDir: string,
  nowMs: number,
  stalenessMs: number,
  isAlive: (pid: number) => boolean = processAlive
): LoopLockState {
  const lock = readLoopLock(locksDir);
  if (!lock) return { state: "free" };
  const lastSeenAt = effectiveLastSeen(lock, readHeartbeat(locksDir));
  return {
    state: loopLockLiveness(lock, nowMs, stalenessMs, isAlive, undefined, lastSeenAt),
    lock,
    lastSeenAt,
  };
}

export interface AcquireResult {
  acquired: boolean;
  held?: LoopLock; // the lock that blocked us (acquired === false)
  reason?: "live" | "stale"; // why we were blocked
}

// Exclusive-create is the compare-and-swap: two first-invocations racing can't
// both win. On EEXIST we inspect the incumbent. A LIVE lock always refuses (even
// with reconcile: never nuke a running loop). A STALE lock refuses too, unless
// reconcile is set, in which case we clear it and take a fresh one.
export function acquireLoopLock(
  locksDir: string,
  lock: LoopLock,
  opts: { nowMs: number; stalenessMs: number; reconcile?: boolean; isAlive?: (pid: number) => boolean }
): AcquireResult {
  const path = loopLockPath(locksDir);
  mkdirSync(locksDir, { recursive: true });
  const body = JSON.stringify(lock, null, 2) + "\n";
  try {
    writeFileSync(path, body, { flag: "wx", mode: 0o600 }); // exclusive create, owner-only
    return { acquired: true };
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }

  const liveness = inspectLoopLock(locksDir, opts.nowMs, opts.stalenessMs, opts.isAlive);
  if (liveness.state === "live") return { acquired: false, held: liveness.lock, reason: "live" };
  if (liveness.state === "stale" && !opts.reconcile) {
    return { acquired: false, held: liveness.lock, reason: "stale" };
  }
  // stale + reconcile: clear the stale lock and take a fresh one WITHOUT abandoning
  // the exclusive-create guard (issue #14 H11). The old code atomicWrite()+return
  // let two racing --reconcile invocations both "acquire". Serialize the whole
  // clear-and-replace through a one-shot claim file: exactly one racer wins the
  // exclusive-create of the claim, and only under it does it re-inspect + clear a
  // STILL-stale lock and take the loop lock (also exclusive-create). Every loser
  // -- of the claim, or of a fresh lock a racer wrote first -- re-inspects and
  // defers. A process killed inside the claimed section orphans the claim, so the
  // claim carries the SAME payload as the loop lock and claimReconcile judges it with
  // the same liveness rules: a dead claim is superseded, never wedged (issue #144).
  const claimPath = `${path}.reconcile`;
  const gen = claimReconcile(claimPath, body, opts);
  if (gen === null) {
    const again = inspectLoopLock(locksDir, opts.nowMs, opts.stalenessMs, opts.isAlive);
    return { acquired: false, held: again.lock, reason: again.state === "live" ? "live" : "stale" };
  }
  try {
    // Under the claim: a racer that reconciled just ahead of us leaves a fresh LIVE
    // lock -- never clear that.
    const under = inspectLoopLock(locksDir, opts.nowMs, opts.stalenessMs, opts.isAlive);
    if (under.state === "live") return { acquired: false, held: under.lock, reason: "live" };
    rmSync(path, { force: true }); // clear the (still) stale lock
    rmSync(heartbeatPath(locksDir), { force: true }); // and the dead loop's beat (#198)
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      return { acquired: true };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e; // a fresh loop grabbed it in the gap: defer
      const again = inspectLoopLock(locksDir, opts.nowMs, opts.stalenessMs, opts.isAlive);
      return { acquired: false, held: again.lock, reason: again.state === "live" ? "live" : "stale" };
    }
  } finally {
    releaseClaim(claimPath, gen);
  }
}

// Claims are GENERATIONAL: `loop.lock.reconcile`, then `.1`, `.2`, ... The claim in
// force is the HIGHEST generation on disk; superseding a dead one is the exclusive
// create of the NEXT generation, never an unlink of the current one.
function claimGenPath(claimPath: string, gen: number): string {
  return gen === 0 ? claimPath : `${claimPath}.${gen}`;
}

// Take the reconcile claim, or return null to defer (a live reconcile holds it, or a
// racer superseded the same dead claim first). Returns the generation held (issue #144).
//
// Exclusive-create is the mutex and nothing ever unlinks a claim to take it over: an
// unlink-then-create is NOT a compare-and-swap, because the interleave A.rm -> A.create
// -> B.rm(deletes A's fresh claim) -> B.create hands the claim to both racers, and both
// then reconcile the same loop lock. Superseding instead means every racer that judged
// generation N dead races to create N+1, so exactly one wins and the losers see EEXIST.
// A process killed inside the claimed section leaves its generation orphaned; the next
// run judges it with the loop lock's own liveness rules (dead/recycled pid on this host,
// or older than the staleness window) and supersedes it, so nothing wedges.
function claimReconcile(
  claimPath: string,
  body: string,
  opts: { nowMs: number; stalenessMs: number; isAlive?: (pid: number) => boolean }
): number | null {
  const current = currentClaimGen(claimPath);
  if (current !== null && claimLiveness(claimGenPath(claimPath, current), opts) === "live") return null;
  const gen = current === null ? 0 : current + 1;
  try {
    writeFileSync(claimGenPath(claimPath, gen), body, { flag: "wx", mode: 0o600 }); // exclusive create, owner-only
    return gen;
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    return null; // a racer took this generation first: defer to it
  }
}

// The generation in force, or null when no claim file exists at all. Highest wins, so a
// racer reading mid-release (which drops superseded generations first) still sees the
// live one and defers.
function currentClaimGen(claimPath: string): number | null {
  const base = basename(claimPath);
  let names: string[];
  try {
    names = readdirSync(dirname(claimPath));
  } catch {
    return null; // no locks dir yet => no claim
  }
  let gen: number | null = null;
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const suffix = name.slice(base.length);
    const g = suffix === "" ? 0 : /^\.\d+$/.test(suffix) ? Number(suffix.slice(1)) : NaN;
    if (Number.isInteger(g) && (gen === null || g > gen)) gen = g;
  }
  return gen;
}

// Drop the claim we hold. Our own generation goes LAST: while it is on disk it is the
// generation in force, so a racer reading mid-release judges OUR claim (live, until we
// finish) rather than a superseded one.
function releaseClaim(claimPath: string, gen: number): void {
  for (let g = 0; g < gen; g++) rmSync(claimGenPath(claimPath, g), { force: true }); // the orphans we superseded
  rmSync(claimGenPath(claimPath, gen), { force: true });
}

// Liveness of an existing claim file. A claim written before #144 holds a bare session
// string with no payload, so only its mtime is legible -- age alone then decides, which
// is the same fallback a pid-less loop lock gets. A claim that vanished under us reads
// stale: the exclusive create of the next generation is what decides the winner.
function claimLiveness(
  claimPath: string,
  opts: { nowMs: number; stalenessMs: number; isAlive?: (pid: number) => boolean }
): LockLiveness {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(claimPath, "utf8");
    mtimeMs = statSync(claimPath).mtimeMs;
  } catch {
    return "stale";
  }
  // mtime is wall-clock but opts.nowMs is injectable, so shift it into the caller's
  // frame -- the age compared below is then real elapsed time under either clock.
  // (Comparing a raw mtime to an injected nowMs read a day-old orphan as live.)
  let claim: LoopLock = { session: "legacy claim", startedAt: mtimeMs - Date.now() + opts.nowMs };
  try {
    const raw = JSON.parse(text) as any;
    if (typeof raw?.session === "string" && typeof raw?.startedAt === "number") claim = raw as LoopLock;
  } catch {
    // not JSON: keep the mtime fallback
  }
  // A confirmed-alive pid does NOT pin a CLAIM live, unlike a loop lock (#288
  // review). The two have very different lifetimes: a loop lock is held across a
  // whole drain (hours), so "the harness is alive" is good evidence it is still
  // held -- but a claim is held across a handful of filesystem ops (milliseconds),
  // so an old claim is orphaned no matter whose pid it names. Since #288 the claim
  // body carries the harness pid, and without this a run that died inside the
  // claimed section while Claude Code stayed open left a claim that read live
  // FOREVER: every later `--reconcile` deferred to it and reported "stale", which
  // sends the operator straight back to the --reconcile that just no-opped.
  // Reproduced with a 5-hour-old orphan. Pre-#288 it self-healed in one staleness
  // window, because a pid-less claim only had its age to go on.
  //
  // The two arms that still decide are the ones #144 added and that cannot be
  // wrong here: a DEAD pid is stale immediately (the fast heal), and a RECYCLED
  // one likewise. Only "confirmed" is demoted to the age branch. A genuine racer
  // holds the claim for milliseconds, so its claim is always fresh and still
  // defers correctly; only orphans age out.
  return loopLockLiveness(claim, opts.nowMs, opts.stalenessMs, opts.isAlive, (l, h) => {
    const id = confirmIdentity(l, h);
    return id === "confirmed" ? "unknown" : id;
  });
}

export function releaseLoopLock(locksDir: string): void {
  rmSync(loopLockPath(locksDir), { force: true });
  // Not required for correctness -- a beat whose session no longer matches any
  // lock is already ignored -- but a dangling file in the locks dir confuses a
  // human reading it (#198).
  rmSync(heartbeatPath(locksDir), { force: true });
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `locks <command> [args]

  acquire  --slug S --session ID [--pid N] [--staleness-minutes M] [--reconcile]
                                       take the project loop lock, or refuse
                                       (exit 1) naming the live/stale session
  release  --slug S                    remove the project loop lock
  force-release --slug S --session ID [--even-if-running]
                                       clear a loop lock whose liveness cannot be
                                       PROVEN (#288): no recorded pid, a lock from
                                       another host, or an unreadable start-time,
                                       where only the lock's age is legible and the
                                       age says "live". ID must be the holder's
                                       exact session -- a mismatch refuses and names
                                       the real holder, so a pasted command cannot
                                       clear a lock you never looked at. Removes the
                                       loop lock and its heartbeat and NOTHING else;
                                       lane locks, worktree records and worktrees
                                       stay "reconcile"'s business. A lock whose
                                       process is PROVABLY ALIVE is REFUSED: the
                                       session id is printed by the very refusal
                                       that sends you here (and read by the
                                       orchestrator), so it cannot also be the gate.
                                       Pass --even-if-running to say deliberately
                                       that the session is no longer draining --
                                       its turn ended while Claude Code stayed
                                       open, so the process outlives the loop.
  beat     --slug S --session ID [--now MS]
                                       re-stamp the liveness heartbeat; a no-op
                                       unless the loop lock is held by ID
  inspect  --slug S [--staleness-minutes M] [--now MS]
                                       print the loop lock state as JSON
  lane-write  --slug S <ticket> <stage> --session ID [--now MS]
                                       write/re-stamp a lane lock
  lane-remove --slug S <ticket>        remove a lane lock
  worktree-record --slug S <ticket> <retained|disposable> --session ID [--now MS]
                                       record what a lane-terminating action MEANT
                                       to leave behind (#271). "retained" = a park /
                                       skip / stop-lane kept this worktree as the
                                       artifact, so reconcile must never prune it;
                                       "disposable" = a salvage park whose worktree
                                       is meant to die, which behaves like a crash.
  worktree-forget --slug S <ticket>    drop the record (the worktree is gone, or a
                                       re-claim took the lane back)

Paths default to ~/.zstack/projects/<slug>/locks; --dir overrides for tests.`;

// Parses --staleness-minutes to a finite positive number, ZError otherwise
// (issue #14 M19). A garbage value (e.g. a typo'd number) used to yield NaN, and
// `nowMs - startedAt > NaN` is always false -- so every no-pid lock read "live"
// forever and no --reconcile could ever clear it. Fail loud instead of silently
// disabling the staleness judgment.
function stalenessMinutes(stale: string | undefined, fallback: number): number {
  if (stale === undefined) return fallback;
  const min = Number(stale);
  if (!Number.isFinite(min) || min <= 0) {
    throw new ZError(`--staleness-minutes must be a positive number of minutes, got ${JSON.stringify(stale)}.`);
  }
  return min;
}

// Resolves the locks dir and staleness ms for a CLI invocation: --dir wins for
// tests; otherwise ~/.zstack/projects/<slug>/locks and the config's threshold.
function resolveDir(flags: Record<string, string | boolean>): { locksDir: string; stalenessMs: number } {
  const dir = str(flags, "dir");
  const stale = str(flags, "staleness-minutes");
  if (dir) {
    return { locksDir: dir, stalenessMs: stalenessMinutes(stale, DEFAULT_LOCK_STALENESS_MINUTES) * 60_000 };
  }
  const cfg = loadConfig(requireFlag(flags, "slug"));
  const min = stalenessMinutes(stale, cfg.lockStalenessMinutes ?? DEFAULT_LOCK_STALENESS_MINUTES);
  return { locksDir: defaultLocksDir(cfg.slug), stalenessMs: min * 60_000 };
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { positionals, flags } = parseFlags(argv.slice(1), ["reconcile", "even-if-running"]);
    const nowMs = Number(str(flags, "now") ?? Date.now());

    if (cmd === "acquire") {
      const { locksDir, stalenessMs } = resolveDir(flags);
      // host is recorded so a lock's pid is only trusted on the machine that wrote
      // it (issue #14 H12): a foreign-host lock falls back to the age heuristic.
      const lock: LoopLock = { session: requireFlag(flags, "session"), startedAt: nowMs, host: hostname() };
      // #288: the harness pid is the DEFAULT, not something the SKILL has to
      // remember to pass. Prose that must not be forgotten is prose that will be,
      // and the one thing worse than no pid is the wrong one (#164's `$$`), so
      // resolving it here makes the right answer the only reachable one.
      // `--pid` stays an explicit override for the gate tests.
      const pid = str(flags, "pid") ?? harnessPid()?.toString();
      if (pid !== undefined) {
        // Validated at the boundary, same as --staleness-minutes (M19): a garbage
        // value used to become NaN -> `"pid": null` on disk -> the lock read STALE
        // at any age, which is the direction that gets a LIVE loop reconciled away.
        const n = Number(pid);
        if (!Number.isInteger(n) || n <= 0) {
          throw new ZError(`--pid must be a positive integer, got ${JSON.stringify(pid)}.`);
        }
        lock.pid = n;
        // Record the pid's OS start-time now so a later same-host liveness check can
        // detect a recycled pid (issue #14 H12). Null when unreadable -> the lock
        // just falls back to the staleness-age heuristic, never "live forever".
        const st = processStartTime(lock.pid);
        if (st !== null) lock.startTime = st;
      }
      const res = acquireLoopLock(locksDir, lock, { nowMs, stalenessMs, reconcile: flags.reconcile === true });
      if (res.acquired) {
        console.log(`acquired loop lock for session ${lock.session}`);
        return 0;
      }
      const h = res.held!;
      const since = new Date(h.startedAt).toISOString();
      // #198: report the EVIDENCE, not a guess at the cause. The old stale
      // message asserted "the previous loop likely crashed" and sent the
      // operator straight to --reconcile -- which, against a loop that had
      // merely outlived the staleness window, parked its tickets and deleted
      // its worktrees. Liveness is now anchored on a heartbeat, so the reading
      // is worth quoting; the consequence is still spelled out because a
      // genuinely stale-looking lock can still belong to something running.
      const beat = readHeartbeat(locksDir);
      const seen = beat && beat.session === h.session ? beat.lastSeenAt : undefined;
      const agoMin = (t: number) => Math.round((nowMs - t) / 60_000);
      if (res.reason === "live") {
        const seenTxt = seen !== undefined ? `, last seen ${agoMin(seen)}m ago` : "";
        // #288: say WHICH arm decided, and when it was the age heuristic rather
        // than proof, say what to run. A refusal that names no next action is how
        // an operator ends up deleting the lock file by hand, which is what
        // happened on 2026-08-02 -- there was nothing else to do.
        const { arm, proven, evidence } = livenessEvidence(h);
        const slug = str(flags, "slug");
        const target = slug === undefined ? `--dir "${locksDir}"` : `--slug "${slug}"`;
        // The command printed for a PROVABLY-ALIVE lock is deliberately the
        // un-flagged form, which force-release now REFUSES (#288 review): this
        // output is read by the orchestrator as well as by a human, and a
        // paste-and-go that clears a running loop's lock is #198's loss with our
        // own instructions on it. A blind paste lands on an explanation; a human
        // who means it adds --even-if-running.
        const escape = ` If you know that loop is NOT running, clear the lock with: bun lib/locks.ts force-release ${target} --session "${h.session}"`;
        // The escape hatch is offered in BOTH branches, with the severity matched
        // to the evidence. Proof that the HARNESS process is alive is not proof
        // that the drain is still executing: if the orchestrator's turn died --
        // an API error, an interrupt -- while Claude Code stayed open, the pid
        // lives on and this reading is "live" forever, where the age heuristic
        // used to give up after the staleness window. That is the cost of letting
        // proof outrank age, and hiding the way out is how an operator ends up
        // deleting the lock file by hand (2026-08-02) all over again.
        console.error(
          `Refusing to start: a /z-loop is already running on this project in session "${h.session}" ` +
            `(started ${since}${seenTxt}${h.pid ? `, pid ${h.pid}` : ""}). Evidence: ${evidence}.` +
            (proven
              ? ` That is proof, not a guess from age -- stop that loop first. If that session is NOT ` +
                `draining (its turn ended or was interrupted while Claude Code stayed open), the process ` +
                `outlives the loop and this will never clear on its own:${escape}`
              : ` That is a guess from the lock's age (${agoMin(seen ?? h.startedAt)}m < the staleness window), NOT proof it is running.${escape}`)
        );
      } else {
        const evidence =
          seen !== undefined
            ? `no sign of life for ${agoMin(seen)}m (last heartbeat ${new Date(seen).toISOString()})`
            : `no heartbeat was ever recorded (started ${since}, ${agoMin(h.startedAt)}m ago)`;
        console.error(
          `Refusing to start: the loop lock from session "${h.session}" is stale -- ${evidence}. The previous loop most likely crashed. If it is in fact still running, do NOT reconcile: --reconcile parks its tickets back to Ready and deletes its worktrees. Otherwise re-run /z-loop with --reconcile to clear it and recover orphans.`
        );
      }
      return 1;
    }

    if (cmd === "release") {
      const { locksDir } = resolveDir(flags);
      releaseLoopLock(locksDir);
      console.log("released loop lock");
      return 0;
    }

    // #288: the in-band way out of an unprovable-but-live-reading lock. Prints
    // what it is about to clear and what it deliberately is NOT clearing, so the
    // operator can see that recovering the lanes is still reconcile's job.
    if (cmd === "force-release") {
      const { locksDir } = resolveDir(flags);
      const session = requireFlag(flags, "session");
      const res = forceReleaseLoopLock(locksDir, session, { allowLive: flags["even-if-running"] === true });
      if (res.refusedBecause === "session-mismatch") {
        console.error(
          `Refusing to force-release: the loop lock is held by session "${res.held!.session}", not "${session}". ` +
            `Re-run with --session "${res.held!.session}" if that is really the lock you mean to clear.`
        );
        return 1;
      }
      if (res.refusedBecause === "provably-alive") {
        console.error(
          `Refusing to force-release: ${livenessEvidence(res.held!).evidence}. That is PROOF the process holding ` +
            `this lock is running right now, not a guess from the lock's age -- and clearing it lets a second ` +
            `/z-loop start and lets \`reconcile apply\` park that run's tickets back to Ready and force-delete its ` +
            `worktrees (#198). Stop that loop first. If you know the session is no longer draining -- its turn ` +
            `ended or was interrupted while Claude Code stayed open, so the process outlives the loop -- re-run ` +
            `with --even-if-running to say so deliberately.`
        );
        return 1;
      }
      if (res.held === undefined) {
        console.log(`no loop lock to release`);
        return 0;
      }
      // Naming the evidence on the way out matters: if the process was PROVEN
      // ALIVE, the operator has just cleared a lock on a loop that may still be
      // running. Gated on the arm, not on `proven` -- "process N is gone" is also
      // proven, and warning about it told the operator to go stop a process the
      // same sentence had called gone (#288 review).
      const { arm, evidence } = livenessEvidence(res.held);
      console.log(
        `force-released the loop lock from session "${res.held.session}" (${evidence}` +
          `${arm === "alive" ? " -- that process is PROVABLY ALIVE, so make sure that loop really is stopped" : ""}). ` +
          `Lane locks, worktree records and worktrees were NOT touched: run \`reconcile apply\` to recover those.`
      );
      return 0;
    }

    // #198: re-stamp the liveness heartbeat. Called once per z-loop-tick, so it
    // must be cheap and must never fail a drain: "not-held" and "foreign" are
    // reported on stderr and still exit 0, because a lock that vanished or was
    // reconciled away is not something a tick with lanes in flight can fix.
    if (cmd === "beat") {
      const { locksDir } = resolveDir(flags);
      const session = requireFlag(flags, "session");
      const res = writeHeartbeat(locksDir, session, nowMs);
      if (res === "not-held") console.error(`beat: no loop lock held (session "${session}")`);
      if (res === "foreign")
        console.error(`beat: the loop lock is held by another session, not "${session}"`);
      return 0;
    }

    if (cmd === "inspect") {
      const { locksDir, stalenessMs } = resolveDir(flags);
      console.log(JSON.stringify(inspectLoopLock(locksDir, nowMs, stalenessMs)));
      return 0;
    }

    if (cmd === "lane-write") {
      const { locksDir } = resolveDir(flags);
      const ticket = Number(positionals[0]);
      const stage = positionals[1] as Stage;
      if (!Number.isInteger(ticket) || !stage) throw new ZError("Usage: locks lane-write --slug S <ticket> <stage> --session ID");
      writeLaneLock(locksDir, { ticket, stage, session: requireFlag(flags, "session"), claimedAt: nowMs });
      console.log(`wrote lane lock ticket-${ticket} (${stage})`);
      return 0;
    }

    if (cmd === "lane-remove") {
      const { locksDir } = resolveDir(flags);
      const ticket = Number(positionals[0]);
      if (!Number.isInteger(ticket)) throw new ZError("Usage: locks lane-remove --slug S <ticket>");
      removeLaneLock(locksDir, ticket);
      console.log(`removed lane lock ticket-${ticket}`);
      return 0;
    }

    if (cmd === "worktree-record") {
      const { locksDir } = resolveDir(flags);
      const ticket = Number(positionals[0]);
      const disposition = positionals[1] as WorktreeDisposition;
      // The ticket's own shape is enforced by worktreeRecordPath below, which is
      // what the READER's filename regex actually agrees with.
      if (disposition !== "retained" && disposition !== "disposable") {
        throw new ZError("Usage: locks worktree-record --slug S <ticket> <retained|disposable> --session ID");
      }
      writeWorktreeRecord(locksDir, {
        ticket,
        disposition,
        session: requireFlag(flags, "session"),
        writtenAt: nowMs,
      });
      console.log(`recorded worktree ticket-${ticket} as ${disposition}`);
      return 0;
    }

    if (cmd === "worktree-forget") {
      const { locksDir } = resolveDir(flags);
      const ticket = Number(positionals[0]);
      removeWorktreeRecord(locksDir, ticket); // ticket shape enforced by worktreeRecordPath
      console.log(`forgot worktree record ticket-${ticket}`);
      return 0;
    }

    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
