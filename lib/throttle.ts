// Tick-pacing state for /z-loop's per-iteration wrapper (issue #58): a pure
// throttleDelayMs(lastTickMs, nowMs, throttleSeconds) decision plus the
// on-disk state bin/z-loop-tick (#57) persists across process invocations --
// each z-loop-tick run is its own process (there is no daemon), so nothing
// else survives between ticks to pace against. Proactive pacing that keeps
// ProjectsV2 GraphQL point spend under GitHub's 5k/hr budget; complements
// the REACTIVE enforceQuota() backstop (board.ts:199-234), which only
// intervenes once remaining points are already low.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, handleCliError, parseFlags, requireFlag } from "./cli.ts";
import { loadConfig, projectsDir, ZError } from "./config.ts";

export { ZError } from "./config.ts";

// -- on-disk paths (always injected; main() is the only default) ------------

// Loop-tick state dir for a project: where bin/z-loop-tick persists the
// wall-clock time of the last tick it started.
export function defaultLoopDir(slug: string, home = homedir()): string {
  return join(projectsDir(home), slug, "loop");
}

export function lastTickPath(loopDir: string): string {
  return join(loopDir, "last-tick");
}

// -- pure decision ------------------------------------------------------------

// Pure: how long (ms) to sleep before starting the next tick.
// throttleSeconds <= 0 (off) or lastTickMs === null (no prior tick, e.g. the
// very first tick of a project) -> 0. Otherwise the remainder of the minimum
// interval, floored at 0 so a late tick (elapsed >= throttleSeconds) never
// computes a negative sleep.
export function throttleDelayMs(
  lastTickMs: number | null,
  nowMs: number,
  throttleSeconds: number
): number {
  if (throttleSeconds <= 0 || lastTickMs === null) return 0;
  return Math.max(0, throttleSeconds * 1000 - (nowMs - lastTickMs));
}

// -- on-disk state --------------------------------------------------------------

// Null when no tick has ever run for this project (fresh loopDir/file). A
// present-but-corrupt file fails loudly -- same discipline as board.ts's
// resetAt guard (board.ts:222-231) -- rather than silently disabling the
// throttle.
export function readLastTick(loopDir: string): number | null {
  const path = lastTickPath(loopDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const ms = Number(raw);
  if (!Number.isFinite(ms)) {
    throw new ZError(
      `Last-tick file at ${path} is not a parseable timestamp: ${JSON.stringify(raw)}.`
    );
  }
  return ms;
}

// atomicWrite creates loopDir via mkdirSync(dirname(path), {recursive:true})
// internally (cli.ts:92), so no separate mkdir call is needed here.
export function writeLastTick(loopDir: string, nowMs: number): void {
  atomicWrite(lastTickPath(loopDir), `${nowMs}\n`);
}

// -- wiring: bin/z-loop-tick's per-tick throttle step --------------------------

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The wrapper's throttle step: sleeps out the remainder of throttleSeconds
// since the last tick this project started, then stamps this tick as
// started. Clock and sleep are injected -- same discipline as Board's
// exec/sleep/now (board.ts:27-29, constructor board.ts:176-185) -- so this
// function's own test pins a fake clock and a spy Sleep instead of waiting
// on real time.
export async function throttleTick(
  loopDir: string,
  throttleSeconds: number,
  now: () => number = () => Date.now(),
  sleep: Sleep = defaultSleep
): Promise<void> {
  const delay = throttleDelayMs(readLastTick(loopDir), now(), throttleSeconds);
  if (delay > 0) await sleep(delay);
  writeLastTick(loopDir, now());
}

// -- CLI ------------------------------------------------------------------------

const USAGE = `throttle wait --slug S

  Sleeps out the remainder of the project's tickThrottleSeconds (config.json,
  default 0 = off) since bin/z-loop-tick's last tick, then stamps this tick's
  start time under ~/.zstack/projects/<slug>/loop/last-tick. Called once at the
  top of bin/z-loop-tick's per-tick flow, before its first board call.`;

// now/sleep default to the real clock/timer -- identical to throttleTick's own
// defaults (line 84-85) -- so the CLI entrypoint below is unaffected. Threading
// the same injected seam through main() (review fix, issue #58) lets a test
// pin a fake clock + spy Sleep around the REAL "wait" handler that reads
// cfg.tickThrottleSeconds, instead of only around throttleTick called
// directly: that handler line is the one production path a config typo,
// dropped `?? 0`, or refactor could silently break while every other test
// (which exercises throttleTick directly) stays green.
export async function main(
  argv: string[],
  now: () => number = () => Date.now(),
  sleep: Sleep = defaultSleep
): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    if (cmd === "wait") {
      const { flags } = parseFlags(argv.slice(1));
      const cfg = loadConfig(requireFlag(flags, "slug"));
      await throttleTick(defaultLoopDir(cfg.slug), cfg.tickThrottleSeconds ?? 0, now, sleep);
      return 0;
    }
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
