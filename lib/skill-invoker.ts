// The C8 thin seam /z-loop's End-of-Loop stage shells through to invoke gstack
// skills (/qa-only, /land-and-deploy, /canary, /document-release, /cso,
// /health). A lib function cannot itself call the Skill tool -- only the
// orchestrating harness session can -- so this is NOT a skill executor. It is
// the audit trail: the orchestrator performs the real Skill invocation via its
// own Skill tool, then calls `invoke()` to record that it happened, in order,
// so "green path invoked land-and-deploy -> canary -> document-release, in
// that order" (issue #9 AC2) is a fact on disk, not a claim in prose.
//
// Same discipline as lib/locks.ts: paths are always injected. createInvoker
// takes its log path explicitly, and omitting it yields the in-memory shape
// tests assert against.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { handleCliError, parseFlags, requireFlag } from "./cli.ts";
import { ZError } from "./config.ts";

export const SKILL_NAMES = [
  "qa-only",
  "land-and-deploy",
  "canary",
  "document-release",
  "cso",
  "health",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export interface SkillInvocation {
  skill: SkillName;
  atMs: number;
  note?: string; // one-line result the orchestrator captured from the skill's own output
}

export interface SkillInvoker {
  // Records one invocation and returns it. Order of calls IS the audit order --
  // callers never need to re-sort or timestamp-compare.
  invoke(skill: SkillName, note?: string): SkillInvocation;
  log(): SkillInvocation[]; // every invocation recorded so far, in call order
}

function assertSkillName(skill: string): asserts skill is SkillName {
  if (!(SKILL_NAMES as readonly string[]).includes(skill)) {
    throw new ZError(`Unknown skill "${skill}". Valid: ${SKILL_NAMES.join(", ")}.`);
  }
}

// Appends each invocation as a JSON line to logPath (a file under the loop's
// report dir), so the order the orchestrator actually invoked skills in
// survives a crash and is reviewable after the fact. `logPath` omitted =
// in-memory only, zero filesystem writes -- the shape tests/endloop.test.ts
// drives the red/green fixtures through, asserting on .log() directly. One
// implementation: the persistence is the only thing that ever differed.
export function createInvoker(logPath?: string, now: () => number = Date.now): SkillInvoker {
  const calls: SkillInvocation[] = [];
  if (logPath !== undefined) mkdirSync(dirname(logPath), { recursive: true });
  return {
    invoke(skill, note) {
      assertSkillName(skill);
      const entry: SkillInvocation = note !== undefined ? { skill, atMs: now(), note } : { skill, atMs: now() };
      calls.push(entry);
      if (logPath !== undefined) appendFileSync(logPath, JSON.stringify(entry) + "\n");
      return entry;
    },
    log() {
      return [...calls];
    },
  };
}

// -- CLI ----------------------------------------------------------------------
// The SKILL shells through this to log a skill invocation it just performed
// via its own Skill tool -- this CLI never invokes anything itself.
const USAGE = `skill-invoker record --log <path> --skill <name> [--note <text>]

  Appends one invocation to the JSONL log at <path> (created if missing).
  <name> is one of: ${SKILL_NAMES.join(", ")}.`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    if (cmd === "record") {
      const { flags } = parseFlags(argv.slice(1));
      const logPath = requireFlag(flags, "log");
      const skill = requireFlag(flags, "skill");
      assertSkillName(skill);
      const note = typeof flags.note === "string" ? flags.note : undefined;
      const invoker = createInvoker(logPath);
      const entry = invoker.invoke(skill, note);
      console.log(JSON.stringify(entry));
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
