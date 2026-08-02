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
//   turns         UNIQUE API responses, not transcript lines. Claude Code
//                 writes one line per content block and repeats the response's
//                 usage snapshot on each, so a split response is counted once
//                 (see DEDUP in auditTranscript). Every absolute below is
//                 post-dedup; figures published before that fix read ~1.87x
//                 high, though the component RANKING was unaffected.
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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { handleCliError, parseFlags, str } from "./cli.ts";
import { ZError } from "./config.ts";
import { GLOB_META, SYNTHETIC_MODEL, expandGlob, parseLine } from "./cost.ts";
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

// A transcript with no assistant usage line carries nothing to attribute. On a
// single-file audit that is a real error -- the operator named that file and
// deserves to hear it. On a multi-file audit it is routine: ~3% of a session
// corpus is an abandoned or never-answered session, and aborting the whole
// rollup on the first one made batch auditing impossible (the CLI's own
// documented use, "audit [<transcript.jsonl>...]"). A distinct type is what
// lets the CLI skip THIS case only: parseLine's format-drift assertion, an
// unreadable file, and any other ZError must still abort the run rather than
// silently drop a session's spend from the totals.
export class NoUsageLineError extends ZError {}

export interface SessionAudit {
  file: string;
  turns: number; // unique API responses, post-dedup (see DEDUP note below)
  totalBilled: number;
  staticFloor: number; // per-turn floor
  staticFloorCost: number; // floor x turns
  accretion: number;
  components: ComponentSpend[];
  drainedTickets: number[];
  skippedLines: number; // unparseable
  // Unparseable lines that are NOT the file's last line. A mid-write truncation
  // is by definition the final line, so anything earlier is real corruption and
  // the report must stop explaining it away as a live file caught mid-write.
  skippedBeyondFinalLine: number;
  // Responses whose first-seen line billed 0 while a later sibling billed more.
  // First-wins then discards the real window. Empirically 0 across this
  // machine's corpus, which is exactly why it would go unnoticed the day it
  // changes -- the reconciliation invariant cannot see a window that never
  // entered the sum.
  shadowedWindows: number;
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
  // key -> billed of the FIRST line seen for that response, so a later sibling
  // carrying a real window over a zero first-seen can be counted (shadowedWindows).
  const seenKeys = new Map<string, number>();
  // Counts every real (non-synthetic) assistant usage line seen, whatever it
  // billed and whether or not it deduped away. Distinguishes "this session was
  // abandoned" from "this session has spend I failed to read" when no window
  // survives -- see the branch at the end of this function.
  let realUsageLines = 0;
  // Usage lines belonging to a spawned subagent, skipped because this tool
  // measures the ORCHESTRATOR's window. Counted so a wholly-sidechain file gets
  // an accurate verdict instead of "nothing to attribute", which is false.
  let sidechainUsageLines = 0;
  let skippedLines = 0;
  let skippedBeyondFinalLine = 0;
  let shadowedWindows = 0;
  let drainStarted = false;

  // Index of the last non-blank line: the only position a mid-write truncation
  // can occupy.
  let finalLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      finalLine = i;
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!parsesAsJson(line)) {
      skippedLines++;
      if (i !== finalLine) skippedBeyondFinalLine++;
      continue;
    }
    // Valid JSON: parseLine's assertion still applies to usage-bearing lines.
    const parsed = parseLine(line, `${path}:${i + 1}`);
    const j = JSON.parse(line);
    if (j.isSidechain) {
      if (parsed && parsed.model !== SYNTHETIC_MODEL) sidechainUsageLines++;
      continue;
    }

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
      //
      // DEDUP: Claude Code writes ONE transcript line per content block, and
      // every line of a split response repeats that response's usage snapshot
      // verbatim. Summing per line therefore counts one API call's window once
      // per block. Two different multiples, measured over this machine's
      // 88-session orchestrator corpus: 2.00x by LINE count (17,693 usage lines
      // / 8,839 unique responses) and 1.87x by BILLED TOKENS (4.97B summed
      // per-line vs 2.66B deduped). They differ because duplicate lines skew
      // toward the smaller windows early in a session.
      // The reconciliation invariant does NOT catch this: staticFloorCost and
      // the component weights inflate together, so the audit still balances
      // while every absolute number (turns, totalBilled, per-ticket accretion)
      // reads high. lib/cost.ts's costOfFiles has deduped since it was written;
      // parseLine already hands back the same dedupKeys, so this reuses them
      // rather than inventing a second rule. Keys are per-transcript: the same response
      // appearing in two files is two sessions' worth of re-sent window, which
      // is exactly what rollup() should add up.
      if (parsed && parsed.model !== SYNTHETIC_MODEL) {
        realUsageLines++;
        // Register EVERY key before skipping, never after -- costOfFiles in
        // lib/cost.ts does the same, for the reason its F14 note gives: one
        // response's lines do not all carry the same id fields, so a line
        // carrying BOTH requestId and message.id is the only thing linking
        // them. Skip it before it registers and a later message.id-only sibling
        // looks new and bills the response a second time.
        //
        // Keys register regardless of `billed`, so the FIRST line of a response
        // wins even if its snapshot reads 0. costOfFiles resolves a divergent
        // sibling the same first-wins way; both rest on the same empirical fact
        // (a response's lines repeat one snapshot verbatim -- 0 disagreements
        // across 3,982 multi-line responses on this machine). Pinned by
        // "first-seen snapshot wins when siblings disagree" in the tests, so a
        // divergence would fail a gate rather than silently shift the totals.
        const u = parsed.usage;
        const billed = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        const firstSeen = parsed.dedupKeys.map((k) => seenKeys.get(k)).find((v) => v !== undefined);
        const duplicate = firstSeen !== undefined;
        for (const k of parsed.dedupKeys) if (!seenKeys.has(k)) seenKeys.set(k, billed);
        if (duplicate) {
          // The first line won, but this sibling carries a window it does not.
          // Count it: the discarded window never enters totalBilled, so the
          // reconciliation invariant balances while the total is short.
          if (billed > 0 && firstSeen === 0) shadowedWindows++;
          continue;
        }
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
    // Two very different reasons produce no windows, and conflating them let a
    // real session vanish from a sweep. An abandoned prompt genuinely carries
    // no usage line -- routine in a corpus, and what NoUsageLineError exists to
    // let a sweep skip. A file whose usage lines all exist but whose first-seen
    // snapshot per response reads 0 is NOT that: it has real spend the tool is
    // failing to read, and skipping it silently subtracts a whole session from
    // the rollup while reporting the run as complete. That is drift, so it
    // throws the untolerated kind and stops the sweep.
    if (realUsageLines > 0) {
      throw new ZError(
        `${path} carries ${realUsageLines} assistant usage line(s), but none yielded a billable window: each either ` +
          `billed 0 input tokens or deduped into a line that did. That is not an abandoned session -- it is spend ` +
          `the tool cannot read, and skipping it would drop this session from the totals in silence.`
      );
    }
    // A file whose every line failed to parse is corrupt, not abandoned. The
    // mid-write tolerance above is for a LIVE transcript with some good lines;
    // when none survive, reporting it as an empty session would let a corrupt
    // file skip a sweep silently, which is the same silence realUsageLines
    // guards against one branch up.
    if (skippedLines > 0) {
      throw new ZError(
        `${path} has no parseable line at all (${skippedLines} skipped). A transcript caught mid-write still leaves ` +
          `earlier complete lines, so this reads as corruption rather than an abandoned session, and a sweep must ` +
          `not skip past it as if it held nothing.`
      );
    }
    // A wholly-sidechain file is a spawned subagent's transcript, not an
    // orchestrator session. Skipping it is right -- this tool measures the
    // orchestrator's window -- but "nothing to attribute" would be a false
    // statement about a file full of real subagent spend. Price those with
    // z-cost instead.
    if (sidechainUsageLines > 0) {
      throw new NoUsageLineError(
        `${path} carries only sidechain (subagent) usage lines -- ${sidechainUsageLines} of them -- and no ` +
          `orchestrator turn. This tool measures the orchestrator's own window, so there is nothing here for it to ` +
          `attribute; price subagent transcripts with z-cost.`
      );
    }
    throw new NoUsageLineError(`${path} carries no assistant usage line, so there is nothing to attribute.`);
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
    skippedBeyondFinalLine,
    shadowedWindows,
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
  // The UNION of ticket ids across sessions, not the sum of per-session counts.
  // Summing double-counted every ticket worked across two sessions and made the
  // headline "accretion per ticket touched" read 1.24x low on this repo's own
  // corpus (68 summed vs 55 distinct). An array, not a count, so a --json
  // consumer can audit the set rather than trust the number.
  drainedTickets: number[];
  // Paths skipped as NoUsageLineError. Named, never just counted: a silently
  // dropped session is spend missing from the totals, and the whole point of
  // this tool is that a number cannot be wrong without saying so.
  unauditable: string[];
  turns: number;
  totalBilled: number;
  staticFloorCost: number;
  components: ComponentSpend[];
  skippedLines: number;
  skippedBeyondFinalLine: number;
  shadowedWindows: number;
}

export function rollup(audits: SessionAudit[], unauditable: string[] = []): Rollup {
  const agg = new Map<string, ComponentSpend>();
  const tickets = new Set<number>();
  let turns = 0, totalBilled = 0, staticFloorCost = 0, skippedLines = 0, skippedBeyondFinalLine = 0, shadowedWindows = 0;
  for (const a of audits) {
    turns += a.turns;
    totalBilled += a.totalBilled;
    staticFloorCost += a.staticFloorCost;
    for (const t of a.drainedTickets) tickets.add(t);
    skippedLines += a.skippedLines;
    skippedBeyondFinalLine += a.skippedBeyondFinalLine;
    shadowedWindows += a.shadowedWindows;
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
    unauditable,
    turns,
    totalBilled,
    staticFloorCost,
    components: [...agg.values()].sort((a, b) => b.cost - a.cost),
    drainedTickets: [...tickets].sort((a, b) => a - b),
    skippedLines,
    skippedBeyondFinalLine,
    shadowedWindows,
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
  if (r.skippedLines) {
    // Only claim mid-write when the evidence supports it. A truncation is by
    // definition the last line of a file, so an unparseable line anywhere else
    // is corruption, and explaining it away cost the operator the one signal
    // that some of this session's spend is missing.
    out.push(
      r.skippedBeyondFinalLine > 0
        ? `  (${r.skippedLines} unparseable line(s) skipped, ${r.skippedBeyondFinalLine} of them NOT at end-of-file -- ` +
            `that is corruption, not a live transcript caught mid-write, and those lines' spend is missing from the totals)`
        : `  (${r.skippedLines} unparseable line(s) skipped, all at end-of-file -- a live transcript caught mid-write)`
    );
  }
  if (r.shadowedWindows) {
    out.push(
      `  (${r.shadowedWindows} response(s) whose first transcript line billed 0 while a later sibling billed more; ` +
        `first-seen wins, so those windows are NOT in the totals below)`
    );
  }
  if (r.unauditable.length > 0) {
    out.push(`  (${r.unauditable.length} session(s) skipped -- no assistant usage line, nothing to attribute:)`);
    // Basenames only while they stay distinct. A sweep across the loop's own
    // per-ticket transcript dirs collides on every "builder-1.jsonl", and three
    // identical lines tell the operator nothing about which sessions dropped.
    const names = r.unauditable.map((f) => basename(f)); // not .map(basename): map's index arg lands in basename's `ext`
    const collides = new Set(names).size !== names.length;
    for (const f of r.unauditable) out.push(`     ${collides ? f : basename(f)}`);
  }
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
  if (r.drainedTickets.length > 0) {
    out.push(
      `  drain accretion per ticket touched: ${n(drainTotal / r.drainedTickets.length)} tokens over ${r.drainedTickets.length} distinct ticket(s)`
    );
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

  Sweeps (several paths, or any glob) skip a transcript that carries no
  assistant usage line and name it in the report -- and in --json under
  \`unauditable\`. One literal path is a question about THAT file, so the same
  empty transcript is an error there. Every other failure, including a renamed
  usage key, aborts the whole run in both modes.

  \`turns\` counts unique API responses, not transcript lines: a response split
  across content-block lines repeats its usage snapshot on each and is billed
  once.

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
    // A glob positional is a SWEEP by intent, however many files it happens to
    // match. Deciding tolerance on the expanded count alone made the identical
    // documented command (`audit path/to/*.jsonl`) hard-fail or succeed
    // depending on how many transcripts were sitting in the directory that day.
    // GLOB_META is imported, not restated, so this classifier and the splitting
    // expandGlob does can never disagree about what a glob is.
    let sweep = positionals.length > 1;
    if (positionals.length > 0) {
      for (const p of positionals) {
        // An existing file is a literal path, whatever characters are in its
        // name. Globbing it first let Bun.Glob read "session[1].jsonl" as a
        // character class and silently audit a DIFFERENT file, reporting that
        // one's numbers with exit 0.
        if (existsSync(p)) {
          paths.push(p);
          continue;
        }
        if (GLOB_META.test(p)) {
          sweep = true;
          const expanded = expandGlob(p);
          // Falling through to the literal handed the pattern itself to
          // readFileSync, so a mistyped extension read as a missing file.
          if (expanded.length === 0) throw new ZError(`No files matched "${p}".`);
          paths.push(...expanded);
          continue;
        }
        // Not on disk and not a pattern: keep it so auditTranscript's own
        // "Cannot read transcript at" names the path the operator typed.
        paths.push(p);
      }
      // The same file reachable through two positionals (`dir/*.jsonl
      // dir/a.jsonl`) used to be audited twice and its tokens counted twice --
      // a 1.5x inflation of exactly the absolutes the dedup fix exists to
      // correct, with the reconciliation invariant still passing because both
      // copies balance.
      //
      // realpathSync.native, not resolve(): resolve() normalizes separators and
      // "./" but NOT case, so on Windows -- a case-insensitive filesystem, and
      // where a glob returns the on-disk spelling while the operator types
      // another -- "Alpha.jsonl" and "alpha.jsonl" stayed two entries and the
      // file was billed twice. realpathSync.native returns the canonical
      // on-disk name, and resolves symlinks on POSIX for free. It throws on a
      // path that does not exist, which the fall-through branch above
      // deliberately keeps, so resolve() remains the fallback there.
      // First spelling wins, so the report names paths as the operator typed them.
      const byRealPath = new Map<string, string>();
      for (const p of paths) {
        let key: string;
        try {
          key = realpathSync.native(p);
        } catch {
          key = resolve(p);
        }
        if (!byRealPath.has(key)) byRealPath.set(key, p);
      }
      paths = [...byRealPath.values()];
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
    // One named path is a question about THAT file: an empty transcript is an
    // answer the operator asked for, so it still throws. A sweep -- several
    // paths, or any glob -- must not let one dead session take the rollup with
    // it (see NoUsageLineError). Only that error is tolerated; everything else,
    // including parseLine's format-drift assertion, still aborts.
    const audits: SessionAudit[] = [];
    const unauditable: string[] = [];
    for (const p of paths) {
      try {
        audits.push(auditTranscript(p));
      } catch (e) {
        if (sweep && e instanceof NoUsageLineError) {
          unauditable.push(p);
          continue;
        }
        // A sweep's docs promote it as the primary use, so an abort partway
        // through is a common path, not a rare one. Say how far it got: without
        // this the operator sees one drift message and no sign that 89 of 90
        // sessions parsed cleanly.
        if (paths.length > 1) {
          console.error(
            `context-audit: aborted on ${p} (file ${paths.indexOf(p) + 1} of ${paths.length}; ` +
              `${audits.length} audited cleanly before it). Nothing is reported -- a partial rollup would understate the corpus.`
          );
        }
        throw e;
      }
    }
    if (audits.length === 0) {
      throw new ZError(
        `None of the ${paths.length} transcript(s) carry an assistant usage line, so there is nothing to attribute.`
      );
    }
    const r = rollup(audits, unauditable);
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
