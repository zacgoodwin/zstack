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
//     rather than live, so a dead loop never wedges the next run.
//
// Same discipline as lib/setup-permissions.ts: EVERY path is a parameter here.
// Only main() computes the real ~/.zstack directory, so every test in
// tests/safety.test.ts is structurally incapable of touching a real lock.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_LOCK_STALENESS_MINUTES,
  ZError,
  loadConfig,
  projectsDir,
} from "./config.ts";
import type { Stage } from "./loop.ts";

export { ZError } from "./config.ts";

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
  pid?: number; // best-effort; when present it decides liveness
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

// -- atomic write -------------------------------------------------------------

// tmp + rename: rename() is atomic on the same volume on POSIX and NTFS, so a
// concurrent reader never observes a half-written lane lock (same technique as
// lib/setup-permissions.ts atomicWrite). mode 0o600 (owner-only) is set on the
// temp file before the rename so a lockfile is never world-readable. (No-op on
// Windows, where fs modes don't map to POSIX perms.)
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// -- lane locks ---------------------------------------------------------------

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
// a missing locks dir (returns []) -- a fresh project has none.
export function listLaneLocks(locksDir: string): { path: string; lock: LaneLock }[] {
  let names: string[];
  try {
    names = readdirSync(locksDir);
  } catch {
    return [];
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
// other error means gone. ponytail: assumes same host, which holds for local
// Claude Code (CLAUDE.md); upgrade path is recording the hostname in the lock.
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// A verifiable pid is definitive (a crashed loop's dead pid reads stale at once,
// a running loop's live pid reads live); with no pid we fall back to the age
// heuristic against the configured staleness threshold. Clock injected.
export function loopLockLiveness(
  lock: LoopLock,
  nowMs: number,
  stalenessMs: number,
  isAlive: (pid: number) => boolean = processAlive
): LockLiveness {
  if (lock.pid !== undefined) return isAlive(lock.pid) ? "live" : "stale";
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
  // stale + reconcile (or the file vanished between checks): overwrite.
  atomicWrite(path, body);
  return { acquired: true };
}

export function releaseLoopLock(locksDir: string): void {
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

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[], booleans: string[] = []): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (booleans.includes(key)) flags[key] = true;
      else flags[key] = args[++i];
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = str(flags, name);
  if (!v) throw new ZError(`Missing required --${name}.`);
  return v;
}

// Resolves the locks dir and staleness ms for a CLI invocation: --dir wins for
// tests; otherwise ~/.zstack/projects/<slug>/locks and the config's threshold.
function resolveDir(flags: Record<string, string | boolean>): { locksDir: string; stalenessMs: number } {
  const dir = str(flags, "dir");
  const stale = str(flags, "staleness-minutes");
  if (dir) {
    const min = stale !== undefined ? Number(stale) : DEFAULT_LOCK_STALENESS_MINUTES;
    return { locksDir: dir, stalenessMs: min * 60_000 };
  }
  const cfg = loadConfig(requireFlag(flags, "slug"));
  const min = stale !== undefined ? Number(stale) : cfg.lockStalenessMinutes ?? DEFAULT_LOCK_STALENESS_MINUTES;
  return { locksDir: defaultLocksDir(cfg.slug), stalenessMs: min * 60_000 };
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { positionals, flags } = parseArgs(argv.slice(1), ["reconcile"]);
    const nowMs = Number(str(flags, "now") ?? Date.now());

    if (cmd === "acquire") {
      const { locksDir, stalenessMs } = resolveDir(flags);
      const lock: LoopLock = { session: requireFlag(flags, "session"), startedAt: nowMs };
      const pid = str(flags, "pid");
      if (pid !== undefined) lock.pid = Number(pid);
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
    if (e instanceof ZError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
