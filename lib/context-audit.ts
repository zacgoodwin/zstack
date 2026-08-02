// lib/context-audit.ts -- where did an orchestrator session's context GO?
//
// lib/context-budget.ts answers "how full is the window right now" (one
// integer, used to gate the drain). lib/cost.ts answers "what did this cost in
// dollars" (billed spend across every request). Neither answers the question
// that decides what to optimize: of the tokens this session paid for, which
// CONTENT was responsible.
//
// That question has a specific shape. A long orchestrator session re-sends its
// whole window on every turn, so a byte that enters early is paid for again on
// every later turn. The cost of a piece of content is therefore not its size --
// it is its size times the number of turns it rides in. This module computes
// that, per component, from a real transcript.
//
// -- What is measured exactly, and what is estimated -------------------------
//
// REAL (tokenizer readings, straight from billed usage):
//   totalBilled   sum over turns of (input + cache_read + cache_creation)
//   staticFloor   min billed window across turns, times the turn count. The
//                 minimum is the window right after a /clear (or turn 1), i.e.
//                 system prompt + tool schemas + CLAUDE.md + skill listing --
//                 the part that is re-sent every turn no matter what.
//   accretion     totalBilled - staticFloor. The conversation's own cost.
//
// ESTIMATED (chars/4, used ONLY as a ratio):
//   The split of `accretion` between components. Each content block gets a
//   chars/4 weight times the turns it rides in; those weights are normalized so
//   the components sum to the REAL accretion. So a per-component number is
//   (real accretion) x (that component's share of estimated bytes).
//
// The consequence, stated plainly because it bounds every conclusion drawn from
// this tool: chars/4 is not uniformly accurate across content types -- JSON tool
// parameters tokenize differently from prose -- so a single component's absolute
// number carries that bias. The RANKING is robust to it, because a constant
// scaling error cancels in the ratio. Read this output as "which component
// dominates", never as "component X costs exactly N tokens".
//
// -- The invariant that makes the output trustworthy -------------------------
//
// staticFloor + sum(components) == totalBilled, asserted on every audit.
//
// This is not decoration. The ad-hoc script that motivated this module reported
// tool results at 41% of orchestrator spend because it omitted tool-call
// PARAMETERS from the weight pool: every remaining component's share inflated by
// ~1.9x and nothing in the output indicated a problem. With the invariant, an
// unaccounted component class cannot silently redistribute itself across the
// others -- the reconciliation fails and the audit throws. A component set that
// does not reconcile is a bug in this file, never a finding about the loop.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { handleCliError, parseFlags, str } from "./cli.ts";
import { ZError } from "./config.ts";
import { SYNTHETIC_MODEL, expandGlob, parseLine } from "./cost.ts";
import { mangleProjectDir, resolveSessionTranscript } from "./context-budget.ts";

// -- phases -------------------------------------------------------------------

// A mixed session (an operator debugging the pack in the same window that ran a
// drain) must never report one blended number: the loop's steady-state cost and
// the operator's own file reads are different quantities, and averaging them
// produces a figure that describes neither. Only `drain` is a claim about
// /z-loop.
export type Phase = "drain" | "dev";

// Commands the LOOP itself issues, per z-loop/SKILL.md Step 4. Anything else in
// a drain window is the operator's. Kept as one list so the classifier has a
// single definition to disagree with.
const LOOP_COMMAND = [
  /z-loop-tick/,
  /bun\s+\S*lib\/(loop|locks|transcripts|stage-prompts|notify|throttle|board|cost|reconcile|endloop)\.ts/,
  /\bz-board\b/,
  /\bz-cost\b/,
  /\bjq\b[^|]*\$?TMP/, // the input-<N>.json / notify payload builders
];
// git/gh count as loop work only inside a lane worktree -- the same commands run
// against the main checkout are the operator inspecting the repo.
const LOOP_SCOPED_VCS = /\.worktrees\/(ticket|review)-\d+/;

function isLoopCommand(cmd: string): boolean {
  if (LOOP_COMMAND.some((re) => re.test(cmd))) return true;
  if (/\bgit\b|\bgh\b/.test(cmd)) return LOOP_SCOPED_VCS.test(cmd);
  return false;
}

// -- components ---------------------------------------------------------------

export type Component =
  | "staticFloor"
  | "toolUseParams"
  | "assistantText"
  | "userText"
  | "skillBody"
  | "skillListing"
  | `toolResult:${string}`;

export interface ComponentSpend {
  component: string;
  phase: Phase;
  cost: number; // real tokens, turn-weighted
  calls: number;
  rawTokens: number; // chars/4 of the content itself, un-weighted
}

export interface SessionAudit {
  file: string;
  turns: number;
  totalBilled: number;
  staticFloor: number; // per-turn floor
  staticFloorCost: number; // floor x turns
  accretion: number;
  components: ComponentSpend[];
  drainedTickets: number[];
  skippedLines: number; // unparseable (a live file caught mid-write)
}

// Markers that identify the z-loop SKILL.md body, which arrives as a user
// message when /z-loop is invoked rather than as system-prompt content. Same
// strings tests/ uses; if SKILL.md is reworded these stop matching and the body
// lands in `userText`, which under-reports the skill but cannot break the
// invariant.
const SKILL_BODY_MARKERS = ["Spawn a FRESH harness Agent", "z-loop-tick --slug"];

// A message's `content` is EITHER an array of blocks or a bare string. Iterating
// the string form directly yields one event per CHARACTER: the cost total still
// comes out right (every char sits at the same turn offset, so the weights sum
// identically) but the call count explodes into the hundreds of thousands and
// the row becomes unreadable. Normalize both shapes to a block array.
function contentBlocks(content: unknown): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function blockText(b: any): string {
  if (typeof b === "string") return b;
  if (!b || typeof b !== "object") return "";
  if (typeof b.text === "string") return b.text;
  if (typeof b.thinking === "string") return b.thinking;
  if (b.content !== undefined) return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
  if (b.input !== undefined) return JSON.stringify(b.input);
  return "";
}

// A Bash/PowerShell result is bucketed by what produced it, because "Bash" alone
// is not actionable -- the tick, a lib call, and an operator's grep are three
// different decisions.
function bashBucket(cmd: string): string {
  if (/z-loop-tick/.test(cmd)) return "tick";
  if (/bun\s+\S*lib\/\w+\.ts/.test(cmd)) return "libcall";
  if (/\bz-board\b|\bz-cost\b/.test(cmd)) return "zboard";
  if (/bun test|typecheck|\btsc\b/.test(cmd)) return "tests";
  if (/\bgit\b/.test(cmd)) return "git";
  if (/\bgh\b/.test(cmd)) return "gh";
  return "other";
}

type Ev =
  | { k: "turn"; billed: number }
  | { k: "content"; component: string; tokens: number; phase: Phase };

// Tolerate a line that is not valid JSON (a live transcript caught mid-write),
// exactly as lib/context-budget.ts does -- but keep parseLine's fail-loud
// key-drift assertion for lines that ARE valid JSON. A renamed usage key must
// still throw rather than silently under-report.
function parsesAsJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

export function auditTranscript(path: string): SessionAudit {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ZError(`Cannot read transcript at ${path}: ${(e as Error).message}`);
  }

  const lines = text.split("\n");
  const toolName = new Map<string, string>();
  const toolPhase = new Map<string, Phase>();
  const toolCmd = new Map<string, string>();
  const evs: Ev[] = [];
  const tickets = new Set<number>();
  let skippedLines = 0;
  let drainStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!parsesAsJson(line)) {
      skippedLines++;
      continue;
    }
    // Valid JSON: parseLine's assertion still applies to usage-bearing lines.
    const parsed = parseLine(line, `${path}:${i + 1}`);
    const j = JSON.parse(line);
    if (j.isSidechain) continue;

    if (j.attachment?.type === "skill_listing") {
      evs.push({ k: "content", component: "skillListing", tokens: String(j.attachment.content ?? "").length / 4, phase: drainStarted ? "drain" : "dev" });
      continue;
    }

    const m = j.message;
    if (!m) continue;

    if (m.role === "assistant") {
      for (const b of contentBlocks(m.content)) {
        if (b?.type === "tool_use") {
          const cmd = String(b.input?.command ?? "");
          const isAgent = b.name === "Agent" || b.name === "Task";
          const loop = isAgent || (b.name === "Bash" || b.name === "PowerShell" ? isLoopCommand(cmd) : false);
          if (/z-loop-tick/.test(cmd)) drainStarted = true;
          const phase: Phase = loop && drainStarted ? "drain" : "dev";
          toolName.set(b.id, b.name);
          toolPhase.set(b.id, phase);
          toolCmd.set(b.id, cmd);
          for (const mt of cmd.matchAll(/(?:prompt|input|body|porcelain|diff|ac)-(\d+)\.(?:txt|json|md)/g)) {
            if (phase === "drain") tickets.add(Number(mt[1]));
          }
          evs.push({ k: "content", component: "toolUseParams", tokens: JSON.stringify(b.input ?? {}).length / 4, phase });
        } else if (b?.type === "text") {
          evs.push({ k: "content", component: "assistantText", tokens: String(b.text ?? "").length / 4, phase: drainStarted ? "drain" : "dev" });
        }
      }
      // Synthetic entries are not measurements (see SYNTHETIC_MODEL): a
      // rate-limited or interrupted turn carries all-zero usage and would read
      // as an empty window, which would drag the static floor to 0.
      if (parsed && parsed.model !== SYNTHETIC_MODEL) {
        const u = parsed.usage;
        const billed = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        if (billed > 0) evs.push({ k: "turn", billed });
      }
      continue;
    }

    if (m.role === "user") {
      for (const b of contentBlocks(m.content)) {
        if (b?.type === "tool_result") {
          const name = toolName.get(b.tool_use_id) ?? "unknown";
          const phase = toolPhase.get(b.tool_use_id) ?? (drainStarted ? "drain" : "dev");
          const suffix =
            name === "Bash" || name === "PowerShell" ? `Bash/${bashBucket(toolCmd.get(b.tool_use_id) ?? "")}` : name;
          const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          evs.push({ k: "content", component: `toolResult:${suffix}`, tokens: t.length / 4, phase });
        } else {
          const t = blockText(b);
          const isSkill = SKILL_BODY_MARKERS.some((mk) => t.includes(mk));
          evs.push({
            k: "content",
            component: isSkill ? "skillBody" : "userText",
            // The SKILL.md body IS the loop's instructions, so it is drain cost by
            // definition -- it just happens to arrive before the first tick fires,
            // which is why it cannot be classified by position like the rest.
            tokens: t.length / 4,
            phase: isSkill ? "drain" : drainStarted ? "drain" : "dev",
          });
        }
      }
    }
  }

  const windows = evs.filter((e): e is Extract<Ev, { k: "turn" }> => e.k === "turn").map((e) => e.billed);
  if (windows.length === 0) {
    throw new ZError(`${path} carries no assistant usage line, so there is nothing to attribute.`);
  }
  const totalBilled = windows.reduce((a, b) => a + b, 0);
  const staticFloor = Math.min(...windows);
  const staticFloorCost = staticFloor * windows.length;
  const accretion = totalBilled - staticFloorCost;

  // Turn-weighted raw weights: a block is paid for again on every LATER turn.
  const agg = new Map<string, ComponentSpend>();
  let weightSum = 0;
  let remaining = windows.length;
  const pending: { key: string; component: string; phase: Phase; weight: number; raw: number }[] = [];
  for (const e of evs) {
    if (e.k === "turn") {
      remaining--;
      continue;
    }
    const weight = e.tokens * remaining;
    weightSum += weight;
    pending.push({ key: `${e.component}|${e.phase}`, component: e.component, phase: e.phase, weight, raw: e.tokens });
  }

  // Normalize the estimated weights onto the REAL accretion. weightSum of 0 (a
  // session whose every turn is the floor, e.g. one turn) leaves accretion 0 too,
  // so the invariant still holds with no components.
  const scale = weightSum > 0 ? accretion / weightSum : 0;
  for (const p of pending) {
    const cur = agg.get(p.key) ?? { component: p.component, phase: p.phase, cost: 0, calls: 0, rawTokens: 0 };
    cur.cost += p.weight * scale;
    cur.calls++;
    cur.rawTokens += p.raw;
    agg.set(p.key, cur);
  }

  const components = [...agg.values()].sort((a, b) => b.cost - a.cost);
  assertReconciles(components, staticFloorCost, totalBilled, path);

  return {
    file: path,
    turns: windows.length,
    totalBilled,
    staticFloor,
    staticFloorCost,
    accretion,
    components,
    drainedTickets: [...tickets].sort((a, b) => a - b),
    skippedLines,
  };
}

// The load-bearing check. See the module header for why it exists.
//
// Tolerance is floating-point only: the component costs come from one
// multiplication by `scale`, so the sum can differ from `accretion` in the last
// bits. 1e-6 relative is ~3 tokens on a 3-billion-token corpus -- far tighter
// than any real attribution bug (the one this was written for was 89% off) and
// far looser than float noise.
export function assertReconciles(components: ComponentSpend[], staticFloorCost: number, totalBilled: number, where: string): void {
  const sum = components.reduce((a, c) => a + c.cost, 0) + staticFloorCost;
  const drift = Math.abs(sum - totalBilled);
  if (drift > Math.max(1e-6 * totalBilled, 1e-6)) {
    throw new ZError(
      `${where}: context attribution does not reconcile -- components + staticFloor = ${sum.toFixed(2)} but billed input = ${totalBilled}. ` +
        `Drift ${drift.toFixed(2)}. A component class is unaccounted for, which silently inflates every other component's share. ` +
        `This is a bug in lib/context-audit.ts, not a finding about the loop.`
    );
  }
}

// -- aggregation across sessions ----------------------------------------------

export interface Rollup {
  sessions: number;
  turns: number;
  totalBilled: number;
  staticFloorCost: number;
  components: ComponentSpend[];
  drainedTickets: number;
  skippedLines: number;
}

export function rollup(audits: SessionAudit[]): Rollup {
  const agg = new Map<string, ComponentSpend>();
  let turns = 0, totalBilled = 0, staticFloorCost = 0, drainedTickets = 0, skippedLines = 0;
  for (const a of audits) {
    turns += a.turns;
    totalBilled += a.totalBilled;
    staticFloorCost += a.staticFloorCost;
    drainedTickets += a.drainedTickets.length;
    skippedLines += a.skippedLines;
    for (const c of a.components) {
      const key = `${c.component}|${c.phase}`;
      const cur = agg.get(key) ?? { component: c.component, phase: c.phase, cost: 0, calls: 0, rawTokens: 0 };
      cur.cost += c.cost;
      cur.calls += c.calls;
      cur.rawTokens += c.rawTokens;
      agg.set(key, cur);
    }
  }
  return {
    sessions: audits.length,
    turns,
    totalBilled,
    staticFloorCost,
    components: [...agg.values()].sort((a, b) => b.cost - a.cost),
    drainedTickets,
    skippedLines,
  };
}

// -- report -------------------------------------------------------------------

const n = (x: number) => Math.round(x).toLocaleString("en-US");

export function report(r: Rollup, opts: { drainOnly?: boolean } = {}): string {
  const pct = (x: number) => ((x / r.totalBilled) * 100).toFixed(2) + "%";
  const out: string[] = [];
  out.push(
    `orchestrator context audit -- ${r.sessions} session(s), ${n(r.turns)} turns, ${n(r.totalBilled)} billed input tokens`
  );
  if (r.skippedLines) out.push(`  (${r.skippedLines} unparseable line(s) skipped -- a live transcript caught mid-write)`);
  out.push("");
  out.push(`  ${"static prefix (floor x turns)".padEnd(34)} ${n(r.staticFloorCost).padStart(14)} ${pct(r.staticFloorCost).padStart(8)}`);
  out.push(`  ${"-- accreted conversation --".padEnd(34)} ${n(r.totalBilled - r.staticFloorCost).padStart(14)} ${pct(r.totalBilled - r.staticFloorCost).padStart(8)}`);
  out.push("");
  out.push(`  ${"component".padEnd(34)} ${"cost".padStart(14)} ${"share".padStart(8)} ${"phase".padStart(6)} ${"calls".padStart(7)}`);
  const shown = opts.drainOnly ? r.components.filter((c) => c.phase === "drain") : r.components;
  for (const c of shown) {
    if (c.cost < r.totalBilled * 0.0002) continue; // below 0.02%, noise
    out.push(
      `  ${c.component.slice(0, 34).padEnd(34)} ${n(c.cost).padStart(14)} ${pct(c.cost).padStart(8)} ${c.phase.padStart(6)} ${String(c.calls).padStart(7)}`
    );
  }
  const drainTotal = r.components.filter((c) => c.phase === "drain").reduce((a, c) => a + c.cost, 0);
  const devTotal = r.components.filter((c) => c.phase === "dev").reduce((a, c) => a + c.cost, 0);
  out.push("");
  out.push(`  drain steady-state: ${n(drainTotal)} (${pct(drainTotal)})   operator/dev: ${n(devTotal)} (${pct(devTotal)})`);
  if (r.drainedTickets > 0) {
    out.push(`  drain accretion per ticket touched: ${n(drainTotal / r.drainedTickets)} tokens over ${r.drainedTickets} ticket(s)`);
  }
  return out.join("\n");
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `context-audit <command> [args]

  audit [<transcript.jsonl>...]   attribute billed input by component. With no
                                  paths, audits the session transcript resolved
                                  from --project-dir (default: cwd).
    --project-dir <dir>           resolve the newest session under that cwd
    --drain-only                  show only loop-issued (drain steady-state) rows
    --json                        machine-readable rollup

  Costs are real billed tokens; the split BETWEEN components is a chars/4 ratio
  normalized onto real accretion, so read the ranking, not the absolute numbers.
  See the module header for the exact contract.`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    // --json / --drain-only consume no value; without this list parseFlags
    // treats them as value flags and a trailing --json is a usage error (#156).
    const { positionals, flags } = parseFlags(argv.slice(1), ["json", "drain-only"]);
    if (cmd !== "audit") {
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
      return 1;
    }
    let paths: string[] = [];
    if (positionals.length > 0) {
      for (const p of positionals) {
        const expanded = expandGlob(p);
        paths.push(...(expanded.length > 0 ? expanded : [p]));
      }
    } else {
      const dir = str(flags, "project-dir") ?? process.cwd();
      const resolved = resolveSessionTranscript(dir, homedir());
      if (!resolved) {
        throw new ZError(
          `No session transcript resolved under ${mangleProjectDir(dir)}. Pass transcript paths explicitly, or --project-dir.`
        );
      }
      paths = [resolved];
    }
    const audits = paths.map(auditTranscript);
    const r = rollup(audits);
    if (flags["json"]) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    console.log(report(r, { drainOnly: Boolean(flags["drain-only"]) }));
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
