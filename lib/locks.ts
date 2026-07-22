// The C7 lockfile layer for /z-loop (issue #2): the on-disk claims a running
// loop leaves so a crash/restart or a second concurrent invocation is detectable.
// Two kinds of lock live under `~/.zstack/projects/<slug>/locks/`:
//
//   * Lane locks  `ticket-<N>.json` {ticket, stage, session, claimedAt} -- one
//     per in-flight lane, written at claim, re-stamped on every stage
//     transition, removed at lane end. Atomic (tmp + rename) so a reader never
//     sees a half-written lock. `claimedAt` doubles as the lane's last-touched
//     time, so a stale lock is legible after a crash.
//   * Loop lock   `loop.lock` {session, startedAt, pid?} -- one per project. A
//     second /z-loop on the same project reads it and refuses to start, naming
//     the live session. Liveness: a verifiable pid decides; with no pid, a lock
//     older than the configured staleness threshold is judged stale (crashed)
//     rather than live, so a dead loop never wedges the next run. The one-shot
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
  return l as LoopLock;
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
  identify: (lock: LoopLock) => IdentityCheck = (l) => confirmIdentity(l)
): LockLiveness {
  if (lock.pid !== undefined) {
    if (!isAlive(lock.pid)) return "stale"; // dead pid: our loop is definitely gone
    switch (identify(lock)) {
      case "confirmed":
        return "live"; // alive AND provably ours (start-time matches)
      case "recycled":
        return "stale"; // alive but the pid was reused by an unrelated process
      case "unknown":
        break; // unconfirmable: fall through to the age heuristic
    }
  }
  return nowMs - lock.startedAt > stalenessMs ? "stale" : "live";
}

export interface LoopLockState {
  state: "free" | "live" | "stale";
  lock?: LoopLock; // the existing lock, when state is live or stale
}

export function inspectLoopLock(
  locksDir: string,
  nowMs: number,
  stalenessMs: number,
  isAlive: (pid: number) => boolean = processAlive
): LoopLockState {
  const lock = readLoopLock(locksDir);
  if (!lock) return { state: "free" };
  return { state: loopLockLiveness(lock, nowMs, stalenessMs, isAlive), lock };
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
  return loopLockLiveness(claim, opts.nowMs, opts.stalenessMs, opts.isAlive);
}

function releaseLoopLock(locksDir: string): void {
  rmSync(loopLockPath(locksDir), { force: true });
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `locks <command> [args]

  acquire  --slug S --session ID [--pid N] [--staleness-minutes M] [--reconcile]
                                       take the project loop lock, or refuse
                                       (exit 1) naming the live/stale session
  release  --slug S                    remove the project loop lock
  inspect  --slug S [--staleness-minutes M] [--now MS]
                                       print the loop lock state as JSON
  lane-write  --slug S <ticket> <stage> --session ID [--now MS]
                                       write/re-stamp a lane lock
  lane-remove --slug S <ticket>        remove a lane lock

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
    const { positionals, flags } = parseFlags(argv.slice(1), ["reconcile"]);
    const nowMs = Number(str(flags, "now") ?? Date.now());

    if (cmd === "acquire") {
      const { locksDir, stalenessMs } = resolveDir(flags);
      // host is recorded so a lock's pid is only trusted on the machine that wrote
      // it (issue #14 H12): a foreign-host lock falls back to the age heuristic.
      const lock: LoopLock = { session: requireFlag(flags, "session"), startedAt: nowMs, host: hostname() };
      const pid = str(flags, "pid");
      if (pid !== undefined) {
        lock.pid = Number(pid);
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
      if (res.reason === "live") {
        console.error(`Refusing to start: a /z-loop is already running on this project in session "${h.session}" (since ${since}${h.pid ? `, pid ${h.pid}` : ""}). Stop that loop first.`);
      } else {
        console.error(`Refusing to start: a stale loop lock from session "${h.session}" (since ${since}) is present -- the previous loop likely crashed. Re-run /z-loop with --reconcile to clear it and recover orphans.`);
      }
      return 1;
    }

    if (cmd === "release") {
      const { locksDir } = resolveDir(flags);
      releaseLoopLock(locksDir);
      console.log("released loop lock");
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

    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
