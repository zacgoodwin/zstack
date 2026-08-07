// Per-stage transcript collection (issue #190). A stage's spend is not one
// transcript: the adversarial reviewer spawns 3 skeptic sub-agents (#59), and
// every token they burn is the reviewer stage's cost. z-loop/SKILL.md Step 4
// used to say "take the file for that spawn" -- a LATENT step, so the skeptics'
// transcripts were simply never copied and every adversarial review's Actual
// undercounted by the majority of what it spent.
//
// This is the deterministic replacement (PRINCIPLES.md, latent vs
// deterministic): the harness already records exact parentage, so which files
// belong to a stage is a graph walk, not a judgment call. Claude Code writes
// each sub-agent as a sibling pair under the session's own directory:
//
//   ~/.claude/projects/<mangled-cwd>/<session-uuid>/subagents/
//       agent-<id>.jsonl       the sub-agent's transcript
//       agent-<id>.meta.json   {agentType, description, toolUseId, spawnDepth,
//                               parentAgentId?, model?}
//
// `parentAgentId` is absent exactly on the agents the top-level session spawned
// (verified: 50 of 50 spawnDepth-1 metas in a real drain carry no parent, 37 of
// 37 spawnDepth-2 metas do), so a stage agent is always parentless and its
// skeptics always point at it. Collecting a stage = find its own transcript,
// then take every descendant transitively.
//
// The rejected alternative was an mtime window: "copy every agent-*.jsonl
// written near this stage's" -- what #190's own ticket body proposed, and what
// was tried by hand during loop run 10. Three lanes run concurrently, so a
// sibling reviewer's skeptics interleave in the same flat directory; that sweep
// attributed 8 transcripts to a reviewer that had 3. Wall-clock proximity is not
// parentage, and there is no reason to guess when the parent id is on disk.
//
// Finding the stage's OWN transcript needs a token guaranteed to appear in its
// first user message, since the orchestrator never learns the agent id the
// harness assigned. `spawnTag` is that token: stage-prompts.ts stamps it into
// the prompt as an inert HTML comment, and the same string is passed back here.
// Ambiguity is resolved structurally, not by heuristic -- see findRootAgents.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { handleCliError, parseFlags, requireFlag, str } from "./cli.ts";
import { ZError } from "./config.ts";
import { mangleProjectDir, resolveSessionTranscript } from "./context-budget.ts";
import { KNOWN_STAGES } from "./cost.ts";
// The marker literal is owned by the module that EMITS it, so the format has one
// definition and this reader can never drift from the writer.
import { SPAWN_TAG_MARKER } from "./stage-prompts.ts";
import { isRunId, stageDest } from "./run-id.ts";

// -- run identity (#322, contract C1) ------------------------------------------
// Lives in lib/run-id.ts (cost.ts needs it too, and transcripts<->cost would
// cycle); re-exported here so the tag/dest/collect surface stays one import.
export { isRunId, mintRunId, stageDest } from "./run-id.ts";

// A stage spawn's identity: a deterministic, OPAQUE digest of
// <slug>/<runId>/t<ticket>/<stage>/<attempt>.
//
// Opaque is the whole point, and it is the reviewer's blindness contract that
// forces it (stage-prompts.ts assertReviewerInput). The tag is stamped into the
// prompt, so a plain-text `zstack/t151/reviewer/2` would tell the adversarial
// reviewer that its diff is on review ATTEMPT 2 -- i.e. that an earlier review
// already rejected it. That is exactly the kind of prior-narrative hint the
// four-key gate exists to keep out; whether it biases the reviewer toward
// leniency ("presumably fixed") or severity is unknowable, which is why the
// contract says don't rather than measure it. Hashing removes the question.
//
// Deterministic, not a nonce: the orchestrator computes it twice from the same
// five facts (once for --spawn-tag, once for --tag) with nothing to remember in
// between, and a re-collection recomputes the same string. Traceability is not
// lost -- collect's --name carries the readable <stage>-<attempt> and its --dest
// the ticket, so the manifest and the written filenames still say what a file is.
//
// The runId component (#322/#210): without it, attempt 1 of a stage in run B
// minted the SAME tag as attempt 1 in run A, so a resumed ticket's collection
// matched BOTH spawns' transcripts and the newer overwrote the older. With the
// run folded into the digest, a tag names one spawn of one run, ever.
export function spawnTag(slug: string, runId: string, ticket: number, stage: string, attempt: number): string {
  if (!isRunId(runId)) {
    throw new ZError(`spawnTag: "${runId}" is not a runId (run-<yyyymmdd>-<hhmmss>-<4hex>).`);
  }
  const digest = createHash("sha256").update(`${slug}/${runId}/t${ticket}/${stage}/${attempt}`).digest("hex");
  return `zs-${digest.slice(0, 12)}`;
}

// -- the harness's on-disk graph -----------------------------------------------

export interface AgentMeta {
  agentId: string;
  parentAgentId?: string;
  description?: string;
}

// Where this session's sub-agent transcripts live. resolveSessionTranscript
// returns the session's own <uuid>.jsonl; the sub-agent directory is its
// same-named SIBLING directory, so the path is derived, never re-globbed (a
// second glob could resolve a different session than the one we measured).
//
// Inherits resolveSessionTranscript's documented newest-mtime ceiling: a second
// Claude Code session in the same repo dir can win the race. Sub-agent files
// live one level down, so they never compete for "newest" themselves.
export function subagentsDirFor(cwd: string, home = homedir()): string | undefined {
  const session = resolveSessionTranscript(cwd, home);
  if (session === undefined) return undefined;
  return join(dirname(session), basename(session).replace(/\.jsonl$/i, ""), "subagents");
}

// Every agent-<id>.meta.json in the directory, as a flat list. A meta file that
// is missing, unreadable, or not valid JSON is SKIPPED and named on stderr
// rather than throwing: one unparseable sidecar must not cost the whole stage
// its cost attribution, and the agent it describes is still discoverable as a
// parentless candidate (which is the conservative reading -- see findRootAgents).
export function readAgentMetas(subagentsDir: string): { metas: AgentMeta[]; skipped: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch (e) {
    throw new ZError(`Cannot read the sub-agent transcript directory ${subagentsDir}: ${(e as Error).message}`);
  }
  const metas: AgentMeta[] = [];
  const skipped: string[] = [];
  for (const f of entries.sort()) {
    const m = /^agent-(.+)\.meta\.json$/.exec(f);
    if (!m) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(join(subagentsDir, f), "utf8"));
    } catch (e) {
      console.error(`transcripts: skipping ${f} -- unreadable agent metadata (${(e as Error).message}).`);
      skipped.push(f);
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      console.error(`transcripts: skipping ${f} -- agent metadata is not a JSON object.`);
      skipped.push(f);
      continue;
    }
    metas.push({
      agentId: m[1],
      parentAgentId: typeof parsed.parentAgentId === "string" ? parsed.parentAgentId : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    });
  }
  return { metas, skipped };
}

// How much of an agent-<id>.jsonl's first line we read looking for the spawn
// tag. Stage prompts are POINTER prompts (#57): the payload lives in
// input-<N>.json, so the prompt is size-invariant and the longest first line
// measured across a real drain's 174 sub-agent transcripts was 4,118 bytes. 64
// KiB is ~16x that and bounded, so scanning a directory never reads a 650 KB
// transcript in full just to check its opening line.
const FIRST_LINE_BYTES = 64 * 1024;

// The bounded prefix of a file's first line. Never throws: an unreadable or
// vanished file is simply not a candidate.
function firstLinePrefix(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.allocUnsafe(FIRST_LINE_BYTES);
    const n = readSync(fd, buf, 0, FIRST_LINE_BYTES, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

// Which agents' first user message carries this spawn tag, and of those, which
// are STAGE agents. Two filters, in order:
//
//  1. the tag appears in the first transcript line (the harness writes the
//     spawn prompt there verbatim, as `{"type":"user","message":{...}}`);
//  2. the agent has no parentAgentId.
//
// Filter 2 is the structural half. A sub-agent that echoed its parent's prompt
// -- a reviewer pasting its own header into a skeptic brief -- matches the tag
// too, and picking wrong would attribute a whole stage to one skeptic. Only the
// orchestrator's own spawns are parentless, so the stage agent is always in this
// set and an echoing descendant never is. Returned as a list so the caller
// decides what more-than-one means (it means the same tag was reused, which is
// a caller bug worth failing on, not a case to silently pick from).
export function findRootAgents(subagentsDir: string, tag: string, metas: AgentMeta[]): string[] {
  const hasParent = new Set(metas.filter((m) => m.parentAgentId !== undefined).map((m) => m.agentId));
  const needle = `${SPAWN_TAG_MARKER} ${tag}`;
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch (e) {
    throw new ZError(`Cannot read the sub-agent transcript directory ${subagentsDir}: ${(e as Error).message}`);
  }
  for (const f of entries.sort()) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    if (hasParent.has(m[1])) continue;
    if (firstLinePrefix(join(subagentsDir, f)).includes(needle)) found.push(m[1]);
  }
  return found;
}

// Every descendant of rootId, transitively, sorted by agent id. Excludes the
// root itself. A visited set makes a cyclic parent chain (which the harness
// should never write, and which we cannot verify it never will) terminate
// instead of hanging the collection step.
export function descendantsOf(metas: AgentMeta[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const m of metas) {
    if (m.parentAgentId === undefined) continue;
    const kids = children.get(m.parentAgentId) ?? [];
    kids.push(m.agentId);
    children.set(m.parentAgentId, kids);
  }
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    for (const kid of children.get(queue.shift()!) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      queue.push(kid);
    }
  }
  return out.sort();
}

// -- subtree liveness (#209) ---------------------------------------------------

// The teardown problem this section answers: the reviewer's throwaway worktree
// was removed "after the stage", i.e. when the PARENT returned -- and in #66's
// review that removal fired while two of its three skeptics were still executing
// inside it (one reported `.worktrees/review-66` disappearing from `git worktree
// list` partway through). Children outlive the stage that spawned them, so "the
// parent returned" is not "the subtree finished".
//
// The parent's transcript CANNOT answer this. The obvious reading -- a sub-agent
// is finished once its `toolUseId` shows up as a `tool_result` in the parent's
// file -- only holds for a FOREGROUND spawn, and the loop's skeptics are not
// foreground: stage-prompts.ts tells the reviewer to spawn them with the Agent
// tool and never passes `run_in_background: false`, whose documented default is
// background. A background spawn's tool_result is written at spawn time and says
// "Async agent launched successfully ... The agent is working in the background",
// and it is the ONLY record of that child the parent ever gets (measured: all
// three skeptic ids appear exactly once each in a real reviewer transcript, and
// 77 of 177 real skeptics on this machine were background spawns whose ack landed
// 15s-1501s before the child stopped writing). So parentage alone reads every
// background child as finished the instant it starts -- byte-identical to the #66
// failure -- and no amount of reading the parent can fix that, because the parent
// holds no completion record at all.
//
// Completion evidence therefore comes from the CHILD's own transcript, which is
// append-only and is the one file that keeps changing while the agent runs. Two
// conditions, measured against a live sub-agent rather than assumed:
//
//  1. the last record is a FINAL ANSWER -- an `assistant` entry carrying text and
//     no `tool_use` block. A running agent's last record is the `tool_use` it is
//     blocked on (a 70s probe agent sat on exactly that for the whole 70s), the
//     `tool_result` it just received, or a bare `thinking` chunk; only a returning
//     one ends on text.
//  2. nothing has been appended since, for SUBTREE_QUIET_MS.
//
// Condition 2 is load-bearing, not belt-and-braces: an agent that narrates
// mid-work ("Now I'll write the extraction JSON.") writes a text-only record and
// keeps going, so shape alone would call it finished. The quiet window is what
// separates those from a real return, and it is measured off the record's OWN
// `timestamp` rather than the file's mtime so that copying a transcript (which
// collection does) can never make a live agent look finished.
//
// Every unreadable, unparseable, or undatable input fails toward LIVE (blocks
// removal), and that direction is free: a kept worktree is swept by the batch-end
// cleanup that already removes leftover review worktrees (z-loop/SKILL.md Step 7),
// while a removed one destroys the workspace a running agent is reading. The
// orphan case -- a descendant that returns after its parent's own final message --
// is now observable too: nothing will ever write into the dead parent, but the
// child's own transcript goes terminal and quiet on its own, so a later collection
// sees it done.
//
// THE CONSTANT IS A MEASUREMENT, not a round number. Sample: every sub-agent
// transcript on this machine -- 1,388 files under
// `~/.claude/projects/*/*/subagents/`, the same corpus lib/cost.ts prices -- scanned
// for records agentFinished() would call finished-shape (assistant, content array,
// a text block, no tool_use) that are NOT the last record in their file. That is
// precisely the set of records this heuristic can be wrong about: 9,632 of them.
// Split by what the agent did next:
//
//   * next record is `user` (43 samples): the agent HAD returned and was messaged
//     again later. Not a failure -- the heuristic's answer was right at the time.
//     These hold the largest gaps in the corpus (2,764s / 2,386s / 1,283s) and
//     must be excluded, or the constant is tuned against SendMessage latency.
//   * next record is the agent's OWN `thinking` / `tool_use` (9,589 samples): it
//     narrated and kept working. THESE are the failures -- each is a skeptic that
//     would be declared finished and have `.worktrees/review-<N>` pulled out from
//     under it. p50 1.5s, p90 7.4s, p99 34s, and a long tail: 29 over 60s, 3 over
//     180s (202s, 303s, 423s), 0 over 600s.
//
// So the real mid-work ceiling is 423s, and the 180s this shipped with was 0.43x
// it, not the ~2x an earlier 87-transcript sample suggested -- the three transcripts
// that break it are real and on this machine. Keeping the 2x rule against the
// measured ceiling gives 846s; 900s is that rounded up. The asymmetry above is why
// the margin goes this way and why the rounding goes up: waiting too long costs one
// swept worktree at batch end (nothing waits on this flag -- z-loop/SKILL.md says
// `false` means leave it and move on, and Step 7 sweeps), while cutting it short
// costs a skeptic its workspace mid-run, which is #66's failure exactly.
// tests/transcripts.test.ts pins this ratio so a future edit cannot quietly
// re-introduce a constant below the measured ceiling.
export const SUBTREE_QUIET_MS = 900_000;

// The longest observed gap between a mid-work narration record and the agent's
// next one, over the sample described above. SUBTREE_QUIET_MS must clear it with
// margin; the gate test is the enforcement.
export const MEASURED_MIDWORK_GAP_MS = 423_110;

// The longest SILENCE a healthy stage of each kind actually produced -- the
// quantity subtreeActivityMs() reports the newest end of, measured per stage
// family so the per-stage watchdog budgets (lib/config.ts
// DEFAULT_STAGE_WATCHDOG_MINUTES) are derived rather than guessed.
//
// Method, over every session on this machine: for each orchestrator-spawned
// (parentless) agent plus its transitive descendants, merge their records into
// one timeline -- exactly the series the watchdog observes, since a lane is
// silent only when NOBODY in its subtree has appended -- and take the largest
// gap between consecutive events. Gaps CLOSED by a `user` record on the root are
// excluded for the reason #209 excludes them above: that is the orchestrator
// messaging an agent that had already returned, which measures SendMessage
// latency, not work. 1,143 subtrees: builder 259, qa 293, reviewer 497, merge 94.
//
//   builder   p50 70.6s  p90 196.1s  p99 479.7s  max 608.0s
//   qa        p50 30.6s  p90  59.9s  p99  97.5s  max 174.8s
//   reviewer  p50 36.9s  p90  94.3s  p99 186.0s  max 1161.1s
//   merge     p50  8.6s  p90  30.2s  p99  97.1s  max  97.1s
//
// The reviewer's 19-minute outlier (Reviewer #178) is the shape that makes
// per-stage budgets worth having at all: a reviewer blocked on three BACKGROUND
// skeptics writes nothing itself, and its skeptics were each blocked on their own
// long tool calls, so the whole subtree went quiet while working exactly as
// designed. A single global budget must either clear that -- and be far too
// patient for a merge stage that only runs `gh pr merge` -- or kill it.
//
// These are per-family CEILINGS from this repo's own loop runs; they are NOT a
// floor for a budget. A family whose sample happens to hold no long quiet stretch
// (qa's 174.8s over 293 subtrees) says nothing about the agent-level ceiling that
// MEASURED_MIDWORK_GAP_MS measures over a 22x larger population, which is why
// every shipped default clears BOTH (gate-tested in tests/loop.test.ts).
export const MEASURED_STAGE_SILENCE_MS: Record<"builder" | "qa" | "reviewer" | "merge", number> = {
  builder: 607_966,
  qa: 174_847,
  reviewer: 1_161_119,
  merge: 97_130,
};

// The longest a stage agent that RETURNED NORMALLY has ever run on this machine:
// 3.7 hours, a "Build C9 /z-status dashboard" builder, over 939 stage-described
// parentless agents that came to rest on a final answer (p50 8.0m, p95 27.8m,
// p99 48.6m, 6 over 60m, 2 over 120m). This is the population lib/loop.ts's
// STAGE_CEILING_MINUTES must clear: a ceiling under it would park a stage that
// was going to finish.
export const MEASURED_MAX_STAGE_MS = 13_304_097;

// The `stop_reason` values that END a turn. A record carrying one is the agent's
// last word by definition -- the harness has nothing more to append until someone
// messages it -- so it needs no quiet window at all.
//
// MEASURED, like every other constant here, over all 1,546 sub-agent transcripts
// on this machine. Of the 1,532 that end on a final-answer-shaped record, 1,294
// carry `end_turn`, 16 carry `stop_sequence`, and 222 carry `null` (the streaming
// split the fixtures reproduce). Of the 10,517 final-answer-shaped records that
// were NOT last in their file -- every case this heuristic can be wrong about --
// 10,472 carry `null`, 44 carry `tool_use`, 1 carries `max_tokens`, and ZERO carry
// either value below. So the fast path has no observed false positive, and the
// quiet window still covers the 14.5% of real returns that land with `null`.
//
// This is what makes the batch sweep able to fire at all. Without it, an agent
// that returned normally reads LIVE for the whole 15-minute window, so z-loop's
// Step 7 -- which runs seconds after the merge stage returns, in the same
// `subagents/` directory liveAgentsIn scans -- could never sweep anything.
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

// The longest observed gap between a NON-final-shaped record (the `tool_use` an
// agent is blocked on, the `tool_result` it just took, a bare `thinking` chunk)
// and that agent's next record: 135,373 samples over the same 1,546 transcripts.
// p50 1.3s, p90 9.6s, p99 77s, 25 over 600s, 5 over 1800s, and one 13,004s Bash
// call (the runner-up is 2,986s). That tail is dominated by permission prompts
// and suspended machines rather than work, but it is real and it is measured, so
// the ceiling below is taken against it.
export const MEASURED_MAX_STALL_MS = 13_003_952;

// When a transcript that is NOT resting on a final answer stops proving anything.
//
// The shape check alone can never be satisfied by an agent killed mid-tool-call
// -- the watchdog/crash population #209 exists for -- so before this it read LIVE
// at ANY age, forever. Measured across every sub-agent transcript on this machine,
// 17 of 1,490 were permanently live that way, spread over 8 of 114 sessions (7%),
// and ONE of them disables both `sweep-review` and reconcile's throwaway prunes
// for that session with no way out: the documented escape hatch
// (docs/user-guide/troubleshooting.md) is the thing that gets wedged.
//
// So silence itself eventually reads as finished, whatever the last record's
// shape. The same 2x-the-measured-ceiling rule SUBTREE_QUIET_MS uses: 2 x
// MEASURED_MAX_STALL_MS is 26,008s, rounded up to 8 hours. Long on purpose --
// under this ceiling the ONLY cost of being wrong is a leftover scratch directory
// -- and overridable per call (`--stale-ms`) for the operator who knows the
// session is dead and wants the sweep now.
export const SUBTREE_STALE_MS = 28_800_000;

export interface LivenessWindow {
  now?: number;
  quietMs?: number;
  staleMs?: number;
}

// The clock + both windows, defaults applied once so every caller in this file
// asks the same question.
function window(opts: LivenessWindow): { now: number; quietMs: number; staleMs: number } {
  return { now: opts.now ?? Date.now(), quietMs: opts.quietMs ?? SUBTREE_QUIET_MS, staleMs: opts.staleMs ?? SUBTREE_STALE_MS };
}

// When this agent's transcript was last touched, for the staleness ceiling only.
// The record's own `timestamp` is the primary source (copying a transcript, which
// collection does, must never change the answer); the file's mtime is the fallback
// for the unreadable/undated cases, where it can only ever say "recent" -- which
// keeps them LIVE, the safe direction, until the ceiling clears them.
function lastTouchedMs(subagentsDir: string, id: string, stamped: number): number | undefined {
  if (Number.isFinite(stamped)) return stamped;
  for (const f of [`agent-${id}.jsonl`, `agent-${id}.meta.json`]) {
    try {
      return statSync(join(subagentsDir, f)).mtimeMs;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

// One agent's transcript as its JSONL lines, oldest first. Never throws: a
// missing, unreadable, or empty transcript yields no lines, and every caller here
// treats "no lines" as "this file proves nothing" rather than as evidence.
//
// Shared by the two readers below (agentFinished's shape check and
// lastRecordStampMs's activity scan) so a transcript is parsed one way in this
// file, not two -- #256 needed the tail of the same file #209 already reads.
function transcriptLines(subagentsDir: string, id: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(subagentsDir, `agent-${id}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const trimmed = text.trimEnd();
  return trimmed === "" ? [] : trimmed.split("\n");
}

// Has this agent's own transcript come to rest? Three answers, in the order their
// evidence is strongest: a turn-ending `stop_reason` (proof), silence past the
// staleness ceiling (nothing is running behind a transcript nobody has written to
// in 8 hours), and a final-answer shape that has been quiet for the settling
// window. Everything else -- and every unreadable input -- is LIVE.
function agentFinished(subagentsDir: string, id: string, now: number, quietMs: number, staleMs: number): boolean {
  const lines = transcriptLines(subagentsDir, id);
  let last: any;
  try {
    last = JSON.parse(lines[lines.length - 1]);
  } catch {
    last = undefined; // a half-written final line IS the harness writing right now
  }
  const stamped = Date.parse(last?.timestamp ?? "");
  // The ceiling comes first because it is the one answer that must hold for EVERY
  // shape, including the mid-tool-call crash that can never satisfy the checks
  // below. It is also the only check allowed to fall back to the file's mtime: a
  // ceiling of hours cannot be fooled by a copy, while the settling window --
  // seconds to minutes -- would be, so that one stays on the record's own stamp.
  const touched = lastTouchedMs(subagentsDir, id, stamped);
  if (touched !== undefined && now - touched >= staleMs) return true;
  if (last?.type !== "assistant" || !Array.isArray(last.message?.content)) return false;
  const blocks: string[] = last.message.content.map((b: any) => b?.type);
  if (blocks.includes("tool_use") || !blocks.includes("text")) return false;
  if (TERMINAL_STOP_REASONS.has(last.message.stop_reason)) return true;
  return Number.isFinite(stamped) && now - stamped >= quietMs;
}

// Which of a stage's descendants have NOT been observed finishing, sorted.
export function liveDescendants(
  subagentsDir: string,
  metas: AgentMeta[],
  root: string,
  opts: LivenessWindow = {}
): string[] {
  const { now, quietMs, staleMs } = window(opts);
  return descendantsOf(metas, root).filter((id) => !agentFinished(subagentsDir, id, now, quietMs, staleMs));
}

// The agent id a skipped meta FILENAME describes. readAgentMetas only ever
// pushes names its own `agent-<id>.meta.json` pattern matched, so this always
// resolves for those; anything else is not an agent meta at all.
function agentIdFromMetaName(file: string): string | undefined {
  return /^agent-(.+)\.meta\.json$/.exec(file)?.[1];
}

// Agents whose PARENTAGE is unknown because their meta could not be parsed, and
// whose own transcript does not prove they finished.
//
// This is the hole a subtree-liveness answer would otherwise have. readAgentMetas
// SKIPS an unparseable sidecar (it must -- one bad file cannot cost a whole stage
// its cost attribution), so descendantsOf never sees that agent and the liveness
// walk never checks it: an unreadable meta would report the subtree DONE and
// force-remove the worktree out from under a running skeptic, which is #66's
// failure exactly. A half-written meta is likeliest at SPAWN, i.e. when the child
// is youngest and most certainly still executing.
//
// So unknown parentage fails toward LIVE, like every other unreadable input here.
// Not blindly, though: the child's own transcript is the same evidence
// agentFinished already reads, and one that has come to rest cannot be reading
// any worktree, whoever its parent was. Only the ones that fail that test block.
export function liveUnknownParentage(
  subagentsDir: string,
  skippedMeta: string[],
  opts: LivenessWindow = {}
): string[] {
  const { now, quietMs, staleMs } = window(opts);
  const ids = skippedMeta.map(agentIdFromMetaName).filter((id): id is string => id !== undefined);
  return ids.filter((id) => !agentFinished(subagentsDir, id, now, quietMs, staleMs)).sort();
}

// Every agent in the directory that has not been observed finishing, sorted --
// parentage ignored entirely.
//
// The batch sweep's gate (lib/reconcile.ts sweep-review), which is a different
// question from collect's: not "is THIS stage's subtree done" but "could ANY
// agent of this session still be reading a review worktree". Parentage cannot
// answer that one, because the sweep is handed a directory of leftover
// `review-<N>` checkouts with no stage tag to trace back -- and it does not need
// to: a session with nothing running has nobody to hurt, and that is checkable
// without knowing who spawned whom (it also sidesteps unreadable metas by
// construction, since no meta is read).
//
// A MISSING directory reads as no live agents, and that is evidence rather than a
// fail-open: the harness creates `subagents/` when the session's first sub-agent
// spawns, so its absence means this session has spawned none. That is precisely
// the Step 0 case the unconditional sweep is for. (A second /z-loop in the SAME
// session sees the first run's agents instead, and may well decline -- correct,
// since those skeptics can still be executing; the leftovers just wait.)
//
// Cost is bounded and paid at most twice a run (Step 0, Step 7): one whole-file
// read per sub-agent transcript in the session -- 174 files, ~650 KB at the
// largest, in a real three-lane drain.
export function liveAgentsIn(subagentsDir: string, opts: LivenessWindow = {}): string[] {
  const { now, quietMs, staleMs } = window(opts);
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of entries) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    if (!agentFinished(subagentsDir, m[1], now, quietMs, staleMs)) out.push(m[1]);
  }
  return out.sort();
}

// -- subtree activity (#256) ---------------------------------------------------

// When this agent last APPENDED anything, by the record's own clock.
//
// Scans backwards for the newest record that carries a parseable `timestamp`,
// rather than reading only the last line, because the two shapes that make a
// last line undatable are both shapes a WORKING agent produces: a final line
// caught half-written (the harness is appending right now) and a record with no
// timestamp field at all. Reading only the tail would call those "no activity"
// and hand the watchdog a silence it did not observe. The scan is bounded by the
// file and stops at the first datable record, so the normal case reads one line.
//
// The record's OWN timestamp, never the file's mtime -- the same rule
// agentFinished's settling window follows and for the same reason: collection
// COPIES transcripts (collectTranscripts above), and an mtime would make a copied
// transcript look freshly active. Here that would be worse than in the liveness
// check, because this number is what tells the watchdog a wedged stage is wedged.
function lastRecordStampMs(subagentsDir: string, id: string): number | undefined {
  const lines = transcriptLines(subagentsDir, id);
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const stamp = Date.parse(rec?.timestamp ?? "");
    if (Number.isFinite(stamp)) return stamp;
  }
  return undefined;
}

// The newest transcript append anywhere in ONE stage spawn's subtree: the stage
// agent itself plus every descendant, transitively. This is the signal
// LaneState.lastActivityMs claimed to hold and never did (#256) -- the watchdog
// was comparing `now` against the moment the STAGE STARTED, so it fired
// watchdogMinutes after a claim however hard the agent was working, and a QA
// stage crossed the 10-minute default while still running the mandatory suite.
//
// The whole SUBTREE, not just the stage agent: the reviewer's three skeptics do
// the work of the reviewer stage (#190 prices them as that stage's spend for the
// same reason), and a reviewer blocked on three live skeptics writes nothing of
// its own for as long as they run. Taking the newest stamp across the subtree
// makes "someone in this stage is working" the thing observed, which is what the
// watchdog is actually asking.
//
// FAILS OPEN, always: `undefined` means "no observation", never "silent". Every
// unresolvable input lands there -- no session transcript directory, a tag no
// parentless agent carries (the spawn has not written its first line yet, or the
// prompt was built without --spawn-tag), a tag carried by more than one root (the
// ambiguity collectTranscripts refuses to guess at), an unreadable subtree.
// The caller must then keep whatever baseline it already had, which is today's
// stage-age behavior: a fail-closed reading here would park a healthy lane on a
// missing sidecar, and this signal exists to stop exactly that class of loss.
//
// An agent whose meta could not be parsed is NOT counted (readAgentMetas skipped
// it, so descendantsOf never sees it) -- the opposite of liveUnknownParentage's
// rule, on purpose. There, an unknown agent must read LIVE because being wrong
// costs a running skeptic its worktree; here, counting a stranger's appends as
// this stage's would silence the watchdog on a wedged lane, which is the run-10
// mis-attribution defect wearing a safety label. Being wrong this way costs one
// probe, which a live lane answers ALIVE.
//
// Cost is one `readdir` + one meta parse per agent (shareable via `metas`) + one
// bounded first-line read per parentless agent + one read per subtree member.
// Paid once per live lane per tick, against the same directory liveAgentsIn
// scans twice a run.
export function subtreeActivityMs(subagentsDir: string, tag: string, metas?: AgentMeta[]): number | undefined {
  let resolved: AgentMeta[];
  let roots: string[];
  try {
    resolved = metas ?? readAgentMetas(subagentsDir).metas;
    roots = findRootAgents(subagentsDir, tag, resolved);
  } catch {
    return undefined; // an unreadable subagents dir observes nothing
  }
  if (roots.length !== 1) return undefined;
  let newest: number | undefined;
  for (const id of [roots[0], ...descendantsOf(resolved, roots[0])]) {
    const stamp = lastRecordStampMs(subagentsDir, id);
    if (stamp !== undefined && (newest === undefined || stamp > newest)) newest = stamp;
  }
  return newest;
}

// -- collection ----------------------------------------------------------------

export interface CollectedFile {
  agentId: string;
  role: "stage" | "descendant";
  file: string; // basename written under dest
}

export interface CollectResult {
  tag: string;
  root: string;
  dest: string;
  files: CollectedFile[];
  descendants: number;
  skippedMeta: string[];
  // #209: agents not observed finishing -- descendants of this stage, plus any
  // whose meta was unreadable (parentage unknown, so possibly one of them) --
  // and the teardown verdict derived from them, which is `false` whenever the
  // set is non-empty. Collection already walks the subtree for the Actual, so
  // the removal decision rides on that same walk instead of a second mechanism --
  // which is also what orders it correctly: teardown happens after collection.
  live: string[];
  subtreeDone: boolean;
}

// Descendants are named by their AGENT ID, not by a 1..k counter. A counter is
// only stable if the descendant set never changes between collections: insert a
// late-finishing skeptic and every later index shifts, leaving the previous
// run's file behind under a name that now duplicates a different agent's
// transcript. z-cost dedupes by requestId so the dollar total survives that, but
// the directory would be quietly wrong. Keying on the id makes re-collection
// idempotent by construction and lets a human trace any file back to its
// meta.json. stageOfFile (lib/cost.ts) splits on the FIRST "-", so
// `reviewer-2-sub-<id>.jsonl` still buckets under "reviewer".
function destName(name: string, agentId: string | null): string {
  return agentId === null ? `${name}.jsonl` : `${name}-sub-${agentId}.jsonl`;
}

export function collectTranscripts(opts: {
  subagentsDir: string;
  tag: string;
  dest: string;
  name: string;
  // #209: injected only by the liveness tests, which need a fixed clock to pin
  // the quiet window's and the staleness ceiling's boundaries. Production always
  // takes the defaults.
  now?: number;
  quietMs?: number;
  staleMs?: number;
}): CollectResult {
  const { metas, skipped } = readAgentMetas(opts.subagentsDir);
  const roots = findRootAgents(opts.subagentsDir, opts.tag, metas);
  if (roots.length === 0) {
    throw new ZError(
      `No stage transcript carries spawn tag "${opts.tag}" (${opts.name}) under ${opts.subagentsDir}. ` +
        `Either the stage prompt was built without --spawn-tag (so the tag never reached the agent), ` +
        `or the tag does not match the one the prompt was built with. This stage's tokens would go ` +
        `uncounted, so refusing to write a partial transcript set.`
    );
  }
  if (roots.length > 1) {
    throw new ZError(
      `Spawn tag "${opts.tag}" (${opts.name}) matches ${roots.length} orchestrator-spawned agents ` +
        `(${roots.join(", ")}) under ${opts.subagentsDir}. A tag names ONE spawn -- one ` +
        `slug/ticket/stage/attempt. Re-using an attempt number for two spawns makes their spend ` +
        `indistinguishable; refusing to guess.`
    );
  }
  const root = roots[0];
  mkdirSync(opts.dest, { recursive: true });
  const files: CollectedFile[] = [];
  for (const [agentId, role] of [[root, "stage"] as const, ...descendantsOf(metas, root).map((d) => [d, "descendant"] as const)]) {
    const file = destName(opts.name, role === "stage" ? null : agentId);
    copyFileSync(join(opts.subagentsDir, `agent-${agentId}.jsonl`), join(opts.dest, file));
    files.push({ agentId, role, file });
  }
  // Two sources of "maybe still running", unioned: the descendants the parentage
  // walk found, and the agents whose meta could not be parsed at all (see
  // liveUnknownParentage -- an unreadable sidecar hides its agent from the walk,
  // so it must not read as a finished subtree). The union is what `subtreeDone`
  // answers, so the teardown gate can never be told DONE on evidence this object
  // was already holding in `skippedMeta` and ignoring.
  const w: LivenessWindow = { now: opts.now, quietMs: opts.quietMs, staleMs: opts.staleMs };
  const live = [
    ...new Set([
      ...liveDescendants(opts.subagentsDir, metas, root, w),
      ...liveUnknownParentage(opts.subagentsDir, skipped, w),
    ]),
  ].sort();
  return {
    tag: opts.tag,
    root,
    dest: opts.dest,
    files,
    descendants: files.length - 1,
    skippedMeta: skipped,
    live,
    subtreeDone: live.length === 0,
  };
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `transcripts <command> [args]

  tag --slug <slug> --run <runId> --ticket <n> --stage <stage> --attempt <k>
        print the opaque spawn tag for one stage spawn (deterministic; the same
        five facts always print the same tag). --run is the state.json runId
        (run-<yyyymmdd>-<hhmmss>-<4hex>) so a re-used attempt number in a LATER
        run can never collide with an earlier run's spawn (#210). Pass the SAME
        string to \`stage-prompts prompt ... --spawn-tag\` and to \`collect --tag\`.

  dest --state-dir <dir> --run <runId> --ticket <n> --stage <stage> --attempt <k>
        print the canonical artifact directory for one stage spawn:
        <state-dir>/runs/<runId>/t<n>/<stage>-<k>. The ONLY composer of this
        path -- the SKILL passes its output to \`collect --dest\` verbatim, so
        the layout lives in code, not prose.

  collect --tag <tag> --dest <dir> --name <stage>-<attempt>
          [--project-dir <dir>] [--subagents-dir <dir>]
        copy the stage agent's transcript and EVERY sub-agent it spawned
        (transitively) into <dir>, as <name>.jsonl and
        <name>-sub-<agentId>.jsonl, and print a JSON manifest. --project-dir
        defaults to the current working directory (the orchestrator's cwd);
        --subagents-dir overrides the resolved location outright.
        The manifest's \`subtreeDone\` (and \`live\`) answer whether every
        descendant has finished -- the gate a stage worktree removal must pass,
        since children outlive the parent that spawned them (#209).`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1));
    if (cmd === "tag") {
      const ticketArg = requireFlag(flags, "ticket");
      const attemptArg = requireFlag(flags, "attempt");
      const ticket = Number(ticketArg);
      const attempt = Number(attemptArg);
      if (!Number.isInteger(ticket) || ticket <= 0) throw new ZError(`--ticket must be a positive integer, got ${JSON.stringify(ticketArg)}.`);
      if (!Number.isInteger(attempt) || attempt <= 0) throw new ZError(`--attempt must be a positive integer, got ${JSON.stringify(attemptArg)}.`);
      // A typo'd stage would mint a perfectly valid-looking tag, and the
      // matching `--name <stage>-<attempt>` would then bucket every collected
      // file under "other" in the spend-by-stage table -- the reviewer's dollars
      // silently leaving the reviewer row. Same set lib/cost.ts prices against,
      // so the two can't disagree.
      const stage = requireFlag(flags, "stage");
      if (!KNOWN_STAGES.has(stage)) {
        throw new ZError(
          `--stage must be one of ${[...KNOWN_STAGES].join(", ")}, got ${JSON.stringify(stage)}.`
        );
      }
      const runId = requireFlag(flags, "run");
      if (!isRunId(runId)) {
        throw new ZError(
          `--run must be a runId (run-<yyyymmdd>-<hhmmss>-<4hex>, the state.json "runId" field), got ${JSON.stringify(runId)}.`
        );
      }
      console.log(spawnTag(requireFlag(flags, "slug"), runId, ticket, stage, attempt));
      return 0;
    }
    if (cmd === "dest") {
      const ticketArg = requireFlag(flags, "ticket");
      const attemptArg = requireFlag(flags, "attempt");
      const ticket = Number(ticketArg);
      const attempt = Number(attemptArg);
      if (!Number.isInteger(ticket) || ticket <= 0) throw new ZError(`--ticket must be a positive integer, got ${JSON.stringify(ticketArg)}.`);
      if (!Number.isInteger(attempt) || attempt <= 0) throw new ZError(`--attempt must be a positive integer, got ${JSON.stringify(attemptArg)}.`);
      const stage = requireFlag(flags, "stage");
      if (!KNOWN_STAGES.has(stage)) {
        throw new ZError(`--stage must be one of ${[...KNOWN_STAGES].join(", ")}, got ${JSON.stringify(stage)}.`);
      }
      console.log(stageDest(requireFlag(flags, "state-dir"), requireFlag(flags, "run"), ticket, stage, attempt));
      return 0;
    }
    if (cmd === "collect") {
      const tag = requireFlag(flags, "tag");
      const dest = requireFlag(flags, "dest");
      const name = requireFlag(flags, "name");
      const projectDir = str(flags, "project-dir") ?? process.cwd();
      const subagentsDir = str(flags, "subagents-dir") ?? subagentsDirFor(projectDir);
      if (subagentsDir === undefined) {
        throw new ZError(
          `No session transcript resolved under ${join(homedir(), ".claude", "projects", mangleProjectDir(projectDir))}, ` +
            `so the sub-agent directory is unknown. Pass --subagents-dir explicitly.`
        );
      }
      console.log(JSON.stringify(collectTranscripts({ subagentsDir, tag, dest, name })));
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
