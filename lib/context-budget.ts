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
// Fail-open by construction (bin/z-loop-tick:66-70 discipline): an unresolvable
// or unreadable transcript returns 0, which never gates -- the run degrades to
// pre-#131 behavior (drains to real drain-complete) rather than wedging. Only a
// transcript that IS readable but whose usage keys were renamed still fails
// loud, via parseLine's format-drift assertion (reused from lib/cost.ts).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handleCliError, parseFlags, str } from "./cli.ts";
import { parseLine } from "./cost.ts";

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

// Current context occupancy from a transcript: the input side (input +
// cache-read + cache-creation tokens; output excluded) of the LAST assistant
// line carrying usage -- the size of the window sent on that turn. A missing/
// unreadable file, or one with no assistant-usage line, returns 0 (fail-open).
// parseLine keeps its hardened parse + fail-loud key assertion, so a renamed
// usage key still throws rather than silently under-reading occupancy.
export function currentContextTokens(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0; // unreadable -> fail-open
  }
  let last: ReturnType<typeof parseLine> = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i], `${path}:${i + 1}`);
    if (parsed) last = parsed;
  }
  if (!last) return 0;
  const u = last.usage;
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

// The whole measurement: resolve the orchestrator's transcript from its cwd,
// read current occupancy. 0 whenever the transcript can't be resolved/read.
export function contextBudget(cwd: string, home = homedir()): number {
  const path = resolveSessionTranscript(cwd, home);
  return path === undefined ? 0 : currentContextTokens(path);
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
