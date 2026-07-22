// z-stop (#132): request a GRACEFUL stop of the /z-loop running on THIS machine
// for a project. z-stop runs as a SEPARATE process from the live loop, so it must
// NOT write the board or state.json -- that would race the loop's single-writer
// discipline. Instead it drops ONE sentinel file next to state.json, and the
// running loop observes it on its own next tick (bin/z-loop-tick) and does all the
// draining itself (lib/loop.ts nextAction's stop branch): pull no new tickets, let
// in-flight lanes finish to Done, return unclaimed tickets to Ready, then exit
// through the normal Step 7 path.
//
// Same per-machine model as loop.lock (the SKILL's UNSUPPORTED cross-machine
// note): z-stop targets a loop running on THIS machine. And the same
// path-injection discipline as lib/locks.ts: every path is a parameter
// (--locks-dir, --sentinel) so tests never touch a real ~/.zstack.
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, handleCliError, parseFlags, str } from "./cli.ts";
import { DEFAULT_LOCK_STALENESS_MINUTES, loadConfig, projectsDir, ZError } from "./config.ts";
import { defaultLocksDir, inspectLoopLock } from "./locks.ts";

export { ZError } from "./config.ts";

// The source of truth for the sentinel filename. The loop's STATE_DIR is
// `.../<slug>/loop` (SKILL Step 0), so the sentinel sits next to state.json.
// bin/z-loop-tick tests the same "stop-requested" literal at
// `dirname(state.json)/stop-requested` -- keep the two in sync.
export function stopSentinelPath(slug: string, home = homedir()): string {
  return join(projectsDir(home), slug, "loop", "stop-requested");
}

const USAGE = `z-stop [request] [--slug S] [--locks-dir D] [--sentinel PATH] [--staleness-minutes M] [--now MS]

Request a graceful stop of the /z-loop running on this machine for a project:
drop a sentinel the running loop observes on its next tick. It pulls no new
tickets, lets in-flight lanes finish, and exits; unworked tickets return to Ready.

Paths default to ~/.zstack/projects/<slug>/{locks,loop}; --locks-dir and
--sentinel override both (for tests). Per-machine, like loop.lock.`;

export function main(argv: string[]): number {
  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    // "request" is the only action; accept it as an optional leading word so both
    // `z-stop` (a human in a second terminal) and `z-stop request` work.
    const args = argv[0] === "request" ? argv.slice(1) : argv;
    const { flags } = parseFlags(args);
    const nowMs = Number(str(flags, "now") ?? Date.now());

    // Resolve locksDir + sentinel + staleness. --locks-dir/--sentinel win as a
    // pair (tests); otherwise the slug's ~/.zstack paths and the config's
    // staleness threshold, exactly as lib/locks.ts resolves them.
    const locksDirFlag = str(flags, "locks-dir");
    const sentinelFlag = str(flags, "sentinel");
    let locksDir: string;
    let sentinel: string;
    let stalenessMs: number;
    let slug: string;
    if (locksDirFlag !== undefined || sentinelFlag !== undefined) {
      if (locksDirFlag === undefined || sentinelFlag === undefined) {
        throw new ZError("Pass BOTH --locks-dir and --sentinel, or neither (resolve from --slug).");
      }
      locksDir = locksDirFlag;
      sentinel = sentinelFlag;
      slug = str(flags, "slug") ?? "this project";
      const stale = str(flags, "staleness-minutes");
      stalenessMs = (stale === undefined ? DEFAULT_LOCK_STALENESS_MINUTES : Number(stale)) * 60_000;
    } else {
      const cfg = loadConfig(str(flags, "slug"));
      slug = cfg.slug;
      locksDir = defaultLocksDir(cfg.slug);
      sentinel = stopSentinelPath(cfg.slug);
      stalenessMs = (cfg.lockStalenessMinutes ?? DEFAULT_LOCK_STALENESS_MINUTES) * 60_000;
    }

    const st = inspectLoopLock(locksDir, nowMs, stalenessMs);
    // free: no loop.lock -> nothing to stop. Write NO sentinel (a stray sentinel
    // would silently stop-mode the NEXT /z-loop before its first tick).
    if (st.state === "free") {
      console.log(`No /z-loop is running for ${slug}; nothing to stop.`);
      return 0;
    }
    // stale: the loop crashed -- there is no live process to observe a graceful
    // signal. Point at --reconcile (which clears the wedge), write NO sentinel.
    if (st.state === "stale") {
      const since = new Date(st.lock!.startedAt).toISOString();
      console.log(
        `${slug}'s loop lock is stale (session "${st.lock!.session}" since ${since}). ` +
          `That loop is not running; re-run /z-loop --reconcile to clear it and recover orphans.`
      );
      return 0;
    }
    // live: drop the sentinel (atomic, owner-only) for the running loop to observe.
    atomicWrite(sentinel, "stop-requested\n");
    const pidPart = st.lock!.pid ? `, pid ${st.lock!.pid}` : "";
    console.log(
      `Stop requested for the /z-loop in session "${st.lock!.session}"${pidPart}. ` +
        `It will pull no new tickets, let in-flight lanes finish, and exit; unworked tickets return to Ready.`
    );
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
