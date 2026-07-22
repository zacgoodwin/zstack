// Live orchestrator context-window measurement (issue #131). The /z-loop
// orchestrator is one long-lived Claude Code session that holds no ticket
// context by design (#57), but its window still accretes across a long drain
// (per-tick ticks, stage final messages, completion notes). This reads how
// FULL that window currently is -- deterministically, from the session's own
// transcript -- so the scheduler can pause the run to clear-and-resume before
// the harness auto-compacts, instead of eyeballing context (PRINCIPLES.md).
//
// This is NOT z-cost: costOfFiles sums BILLED tokens across every request
// (cumulative spend). The number here is a single request's INPUT side -- the
// size of the window sent on the most recent turn -- which is what "how full
// am I right now" means and the only thing a context clear affects.
//
// Fail-open by construction: an unresolvable or unreadable transcript -- and a
// transcript line that is not even valid JSON, i.e. a live file caught
// mid-write (#157) -- returns 0 or the last well-formed reading, which never
// gates, so the run degrades to pre-#131 behavior (drains to real
// drain-complete) rather than wedging. Every 0 currentContextTokens and
// contextBudget return goes through unknown() and says so on stderr (#157),
// because a 0 from either is never a measurement of an empty window.
// Only a transcript whose lines ARE valid
// JSON but whose usage keys were renamed still fails loud, via parseLine's
// format-drift assertion (reused from lib/cost.ts): the tolerance below is
// scoped to unparseable text and never swallows format drift.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handleCliError, parseFlags, str } from "./cli.ts";
import { SYNTHETIC_MODEL, parseLine } from "./cost.ts";

// Claude Code stores a session's transcripts under
// ~/.claude/projects/<mangled-cwd>/, where <mangled-cwd> is the working
// directory with every non-alphanumeric character replaced by "-" (verified
// against real dirs on disk, e.g. "D:\Users\zacgo\...\zstack-1" ->
// "D--Users-zacgo---zstack-1", case preserved as the process reported the cwd).
function mangleProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// The orchestrator's own most-recent session transcript: the newest-mtime
// *.jsonl under its ~/.claude/projects/<mangled-cwd>/ dir, or undefined when
// the dir is missing/unreadable (fail-open -> caller reads 0).
//
// ponytail: newest-mtime session resolution. Known ceiling -- misidentifies the
// session if a SECOND Claude Code session runs in the same repo dir, and the
// reading lags the live turn by one transcript flush. Both are acceptable and
// fail-open; upgrade to a harness-provided session-path handle if one appears.
export function resolveSessionTranscript(cwd: string, home = homedir()): string | undefined {
  const dir = join(home, ".claude", "projects", mangleProjectDir(cwd));
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return undefined; // dir missing/unreadable -> fail-open
  }
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const f of files) {
    const path = join(dir, f);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue; // a file that vanished between readdir and stat -> skip
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path;
}

// Every 0 this module returns routes through here, so the operator is always
// told the window size is unknown rather than left to read it as a genuinely
// small one. That the two can't be confused is an empirical fact, not a
// structural one: a returned reading is 0 only if a real assistant usage line
// summed input + cache-read + cache-creation to 0, and across this machine's
// ~/.claude/projects corpus 0 of 78,930 non-synthetic usage lines do (smallest
// real reading: 14,239 tokens). The 27 that DO sum to zero are all synthetic
// entries, which currentContextTokens skips (#157). #157: each unknown path
// says so on stderr (which bin/z-loop-tick no longer discards). Nothing
// downstream can: lib/loop.ts gates on the integer alone and treats an unknown
// 0 exactly like a real small one -- that IS the fail-open intent, and the
// stderr line is the only place the difference exists.
function unknown(reason: string): number {
  console.error(
    `context-budget: ${reason}, so this reading is 0. That 0 means the context size is UNKNOWN here, ` +
      `not known-small: the context ceiling cannot gate on it and the run drains as if the ceiling were off.`
  );
  return 0;
}

function parsesAsJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

// Current context occupancy from a transcript: the input side (input +
// cache-read + cache-creation tokens; output excluded) of the last assistant
// line carrying REAL usage -- the size of the window sent on that turn. A
// missing/unreadable file, or one with no such line, returns 0 (fail-open).
//
// "Real" excludes Claude Code's synthetic assistant entries (#157 review
// finding 2). Claude Code writes one, inline in the transcript, on a
// rate-limited turn (isApiErrorMessage + apiErrorStatus 429) and on an
// interrupted one ("No response requested."); both carry model "<synthetic>"
// and all four usage keys present and ZERO. They parse cleanly, so taking the
// literal last usage line read them as an empty window: 7 of the 1,185
// transcripts on this machine returned a silent 0 that way, 5 of them hiding a
// real last reading (one at 393,005 tokens, 71% of the default ceiling). That
// is the worst possible time to read empty -- a rate limit fires when the
// window is fullest -- so they are skipped, exactly as lib/cost.ts skips them
// on the pricing side. isApiErrorMessage alone would miss the interrupt shape;
// the model string catches both.
//
// #157: a line that is not valid JSON is SKIPPED, not thrown on. The transcript
// this reads is the orchestrator's own live session file, so the tick can catch
// it mid-write with a truncated final line -- which used to throw here and left
// bin/z-loop-tick's `|| echo 0` as the only fail-open, discarding a reading that
// the earlier, complete lines still carry. Skipping is bounded: a surviving
// well-formed usage line is a real measurement of an earlier turn, at most one
// turn stale, which is the same lag resolveSessionTranscript already documents.
// When NOTHING usable survives -- whatever the cause: an unreadable file, an
// empty transcript, one with no assistant-usage line, one whose only lines were
// unparseable, or one whose only usage lines were synthetic -- the 0 returned
// means UNKNOWN, not known-small, and says so on stderr rather than passing
// silently for a healthy small window.
//
// parseLine keeps its hardened parse + fail-loud key assertion for every line
// that IS valid JSON, so a renamed usage key still throws rather than silently
// under-reading occupancy.
export function currentContextTokens(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return unknown(`${path} could not be read`); // fail-open
  }
  let last: ReturnType<typeof parseLine> = null;
  let skipped = 0;
  let firstSkippedLine = 0;
  let synthetic = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let parsed: ReturnType<typeof parseLine>;
    try {
      parsed = parseLine(lines[i], `${path}:${i + 1}`);
    } catch (e) {
      if (parsesAsJson(lines[i])) throw e; // valid JSON, wrong shape -> format drift, stays loud
      if (skipped++ === 0) firstSkippedLine = i + 1;
      continue;
    }
    if (!parsed) continue;
    // Synthetic entries are not measurements (see SYNTHETIC_MODEL in
    // lib/cost.ts, which skips them for the same reason on the pricing side).
    if (parsed.model === SYNTHETIC_MODEL) {
      synthetic++;
      continue;
    }
    last = parsed;
  }
  if (!last) {
    const why = [
      skipped > 0 ? `${skipped} line(s) are not valid JSON (first at line ${firstSkippedLine})` : "",
      synthetic > 0 ? `${synthetic} assistant usage line(s) are synthetic ("${SYNTHETIC_MODEL}") and carry no real usage` : "",
    ].filter(Boolean);
    return unknown(
      why.length > 0
        ? `${path} has no well-formed assistant usage line: ${why.join("; ")}`
        : `${path} carries no assistant usage line at all`
    );
  }
  const u = last.usage;
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

// The whole measurement: resolve the orchestrator's transcript from its cwd,
// read current occupancy. 0 whenever the transcript can't be resolved/read --
// reported as UNKNOWN on stderr, like every other unmeasurable path.
export function contextBudget(cwd: string, home = homedir()): number {
  const path = resolveSessionTranscript(cwd, home);
  return path === undefined
    ? unknown(`no session transcript resolved under ${join(home, ".claude", "projects", mangleProjectDir(cwd))}`)
    : currentContextTokens(path);
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `context-budget current [--project-dir <dir>]

  current   print the orchestrator session's CURRENT context-window token
            occupancy (input + cache-read + cache-creation of its most recent
            request) as a single integer, or 0 if the session transcript
            cannot be resolved or read. --project-dir defaults to the current
            working directory (the orchestrator's cwd).`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1));
    if (cmd === "current") {
      const projectDir = str(flags, "project-dir") ?? process.cwd();
      console.log(String(contextBudget(projectDir)));
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
