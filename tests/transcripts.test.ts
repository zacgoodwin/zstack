// Gate tests for lib/transcripts.ts (issue #190): per-stage transcript
// collection by PARENTAGE, not by wall-clock proximity.
//
// The regression being pinned is concrete. Loop run 10 ran 3 lanes concurrently;
// 12 adversarial reviewers each spawned 3 skeptics into ONE flat sub-agent
// directory, interleaved. The mtime-window sweep tried by hand there (and the
// mechanism #190's own ticket body proposed) attributed 8 transcripts to a
// reviewer that had 3, because wall-clock proximity is not parentage. Every
// collect test below therefore builds SIBLING stage agents in one directory and
// asserts the collected set is exactly one stage's own subtree.
//
// The prompt round trip is pinned end to end: fixtures embed the output of the
// REAL emitter (builderPrompt/reviewerPrompt with a spawn tag), so a change to
// the stamp's format on the writer side fails here on the reader side rather
// than silently making every future collect find nothing. No LLM calls.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZError } from "../lib/config.ts";
import { KNOWN_STAGES } from "../lib/cost.ts";
import { STATUS_FOR_STAGE } from "../lib/loop.ts";
import { SPAWN_TAG_MARKER, builderPrompt, reviewerPrompt } from "../lib/stage-prompts.ts";
import {
  MEASURED_MAX_STALL_MS,
  MEASURED_MIDWORK_GAP_MS,
  SUBTREE_QUIET_MS,
  SUBTREE_STALE_MS,
  collectTranscripts,
  descendantsOf,
  findRootAgents,
  liveAgentsIn,
  liveDescendants,
  main,
  readAgentMetas,
  spawnTag,
  subagentsDirFor,
} from "../lib/transcripts.ts";

const tmpPaths: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "zstack-transcripts-"));
  tmpPaths.push(d);
  return d;
}
afterEach(() => {
  while (tmpPaths.length) rmSync(tmpPaths.pop()!, { recursive: true, force: true });
});

function captureStderr(fn: () => void): string {
  const orig = console.error;
  let out = "";
  console.error = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return out;
}

function captureStdout(fn: () => void): string {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

// A stage prompt as the orchestrator actually builds it, so the fixture carries
// the real stamp rather than a hand-rolled imitation of it.
function stagePromptWithTag(tag: string): string {
  return builderPrompt(
    {
      ticketNumber: 151,
      ticketTitle: "a ticket",
      ticketBody: "read from the file",
      worktreePath: ".worktrees/ticket-151",
      branch: "z/ticket-151",
      baseBranch: "main",
    },
    "/tmp/input-151.json",
    tag
  );
}

// One agent-<id> pair, shaped exactly like Claude Code writes it: the first
// transcript line is the spawn prompt as a `user` entry, and the sidecar carries
// parentAgentId only for a sub-agent (verified against a real drain: 50 of 50
// spawnDepth-1 metas carry no parent, 37 of 37 spawnDepth-2 metas do).
function writeAgent(
  dir: string,
  id: string,
  opts: { prompt?: string; parent?: string; description?: string; extraLines?: string[]; meta?: string } = {}
): void {
  const first = JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    agentId: id,
    type: "user",
    message: { role: "user", content: opts.prompt ?? `an untagged prompt for ${id}` },
  });
  writeFileSync(join(dir, `agent-${id}.jsonl`), [first, ...(opts.extraLines ?? [])].join("\n") + "\n");
  writeFileSync(
    join(dir, `agent-${id}.meta.json`),
    opts.meta ??
      JSON.stringify({
        agentType: "general-purpose",
        description: opts.description ?? `agent ${id}`,
        toolUseId: `toolu_${id}`,
        spawnDepth: opts.parent === undefined ? 1 : 2,
        ...(opts.parent === undefined ? {} : { parentAgentId: opts.parent }),
      })
  );
}

// -- #209 liveness fixtures ----------------------------------------------------
//
// Every shape below was read off real transcripts on this machine (loop run 11,
// plus a live 70-second probe agent), NOT invented. That matters: the first cut
// of this feature shipped green against a fabricated "the parent records the
// child's verdict" fixture, which is a thing the harness does not do for the
// background spawns the loop actually uses.
const NOW = Date.parse("2026-07-29T16:00:00.000Z");
const QUIET = new Date(NOW - 30 * 60_000).toISOString(); // well past SUBTREE_QUIET_MS (15 min)
const RECENT = new Date(NOW - 5_000).toISOString(); // written 5s ago: still noisy

function append(dir: string, id: string, record: unknown): void {
  const path = join(dir, `agent-${id}.jsonl`);
  writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(record) + "\n");
}

// What a sub-agent's transcript ends on WHILE IT RUNS: the `tool_use` it is
// blocked on. A live probe agent sat on exactly this record -- file untouched --
// for the whole 70 seconds of its Bash call, which is why quiescence alone can
// never mean "finished".
function appendRunning(dir: string, id: string, at: string = RECENT): void {
  append(dir, id, {
    isSidechain: true,
    agentId: id,
    type: "assistant",
    message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: `toolu_call_${id}`, name: "Bash", input: {} }] },
    timestamp: at,
  });
}

// What it ends on when it RETURNS: an assistant entry carrying text and no
// tool_use. `stop_reason` is deliberately null here -- 11 of 87 real finished
// transcripts ended that way (streaming splits the final message), so the check
// must not lean on end_turn.
function appendFinalAnswer(dir: string, id: string, at: string = QUIET): void {
  append(dir, id, {
    isSidechain: true,
    agentId: id,
    type: "assistant",
    message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "COULD NOT REFUTE: ..." }] },
    timestamp: at,
  });
}

// What it ends on when it returns and the harness records WHY the turn ended:
// a terminal `stop_reason`. 1,310 of this machine's 1,532 finished sub-agent
// transcripts look like this, and no mid-work record in the corpus does -- which
// is what lets it skip the settling window. `reason` is a parameter so the
// non-terminal values that also appear on text-only records (`tool_use`,
// `max_tokens`) can be held to the window instead.
function appendTerminalAnswer(dir: string, id: string, at: string = QUIET, reason: string = "end_turn"): void {
  append(dir, id, {
    isSidechain: true,
    agentId: id,
    type: "assistant",
    message: { role: "assistant", stop_reason: reason, content: [{ type: "text", text: "COULD NOT REFUTE: ..." }] },
    timestamp: at,
  });
}

// The ONLY record a parent ever gets for a background child, verbatim from a real
// run-11 reviewer transcript: an immediate ack, written at SPAWN time. Reading it
// as a result is the #66 bug -- so the fixtures write it everywhere the loop's
// reviewer would, and the assertions below prove it proves nothing.
function appendBackgroundAck(dir: string, parentId: string, childId: string, at: string = RECENT): void {
  append(dir, parentId, {
    isSidechain: true,
    agentId: parentId,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: `toolu_${childId}`,
          type: "tool_result",
          content: [
            {
              type: "text",
              text:
                `Async agent launched successfully. (This tool result is internal metadata ...)\n` +
                `agentId: ${childId} (internal ID - do not mention to user.)\n` +
                `The agent is working in the background. You will be notified automatically when it completes.`,
            },
          ],
        },
      ],
    },
    timestamp: at,
  });
}

// The loop's reviewer, as it really spawns: three skeptics in the BACKGROUND, so
// the parent holds three acks and nothing else. `finished` names the ones whose
// own transcripts have come to rest.
function backgroundSkeptics(dir: string, parent: string, kids: string[], finished: string[]): void {
  for (const k of kids) {
    appendBackgroundAck(dir, parent, k);
    if (finished.includes(k)) appendFinalAnswer(dir, k);
    else appendRunning(dir, k);
  }
}

// The run-10 shape: two reviewers with three skeptics each, all in one flat
// directory. Returns the two tags.
function twoReviewersWithSkeptics(dir: string): { t1: string; t2: string } {
  const t1 = spawnTag("zstack", 151, "reviewer", 1);
  const t2 = spawnTag("zstack", 164, "reviewer", 1);
  writeAgent(dir, "r1", { prompt: stagePromptWithTag(t1), description: "Review ticket 151" });
  writeAgent(dir, "r2", { prompt: stagePromptWithTag(t2), description: "Review ticket 164" });
  // Interleaved ids, so neither an alphabetical nor an insertion-order sweep
  // could accidentally get the grouping right.
  writeAgent(dir, "s1a", { parent: "r1", description: "Skeptic A of 151" });
  writeAgent(dir, "s2a", { parent: "r2", description: "Skeptic A of 164" });
  writeAgent(dir, "s1b", { parent: "r1", description: "Skeptic B of 151" });
  writeAgent(dir, "s2b", { parent: "r2", description: "Skeptic B of 164" });
  writeAgent(dir, "s1c", { parent: "r1", description: "Skeptic C of 151" });
  writeAgent(dir, "s2c", { parent: "r2", description: "Skeptic C of 164" });
  return { t1, t2 };
}

describe("spawnTag (#190)", () => {
  test("is deterministic across calls", () => {
    expect(spawnTag("zstack", 151, "reviewer", 2)).toBe(spawnTag("zstack", 151, "reviewer", 2));
  });

  test("distinguishes every one of its four facts", () => {
    const base = spawnTag("zstack", 151, "reviewer", 1);
    expect(spawnTag("other", 151, "reviewer", 1)).not.toBe(base);
    expect(spawnTag("zstack", 152, "reviewer", 1)).not.toBe(base);
    expect(spawnTag("zstack", 151, "qa", 1)).not.toBe(base);
    // The attempt is the fact the reviewer's own transcript cannot otherwise
    // supply: run 10 had both "Review ticket 153" and "Review ticket 153
    // attempt 2" in one directory.
    expect(spawnTag("zstack", 151, "reviewer", 2)).not.toBe(base);
  });

  // The blindness reason the tag is a digest at all (lib/stage-prompts.ts
  // assertReviewerInput): a readable tag stamped into the reviewer's prompt
  // would tell it this is review ATTEMPT 2, i.e. that an earlier review already
  // rejected the diff -- prior-narrative context the four-key gate exists to
  // keep out.
  test("leaks none of its inputs in plain text", () => {
    const tag = spawnTag("zstack", 151, "reviewer", 2);
    expect(tag).not.toContain("zstack");
    expect(tag).not.toContain("151");
    expect(tag).not.toContain("reviewer");
    expect(tag).toMatch(/^zs-[0-9a-f]{12}$/);
  });
});

describe("readAgentMetas (#190)", () => {
  test("reads ids and parent links, ignoring non-agent files", () => {
    const dir = mkTmp();
    writeAgent(dir, "root");
    writeAgent(dir, "kid", { parent: "root" });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    const { metas, skipped } = readAgentMetas(dir);
    expect(skipped).toEqual([]);
    expect(metas.map((m) => [m.agentId, m.parentAgentId ?? null])).toEqual([
      ["kid", "root"],
      ["root", null],
    ]);
  });

  // Tolerant on purpose: one unparseable sidecar must not cost the whole stage
  // its cost attribution. The agent it described stays discoverable as a
  // parentless candidate, which is the conservative reading.
  test("skips a corrupt meta and names it on stderr", () => {
    const dir = mkTmp();
    writeAgent(dir, "root");
    writeAgent(dir, "broken", { meta: "{not json" });
    let result!: ReturnType<typeof readAgentMetas>;
    const err = captureStderr(() => {
      result = readAgentMetas(dir);
    });
    expect(result.skipped).toEqual(["agent-broken.meta.json"]);
    expect(result.metas.map((m) => m.agentId)).toEqual(["root"]);
    expect(err).toContain("agent-broken.meta.json");
    expect(err).toContain("unreadable agent metadata");
  });

  test("skips a meta that is valid JSON but not an object", () => {
    const dir = mkTmp();
    writeAgent(dir, "weird", { meta: '"a string"' });
    let result!: ReturnType<typeof readAgentMetas>;
    const err = captureStderr(() => {
      result = readAgentMetas(dir);
    });
    expect(result.skipped).toEqual(["agent-weird.meta.json"]);
    expect(err).toContain("not a JSON object");
  });

  test("throws a named error on a missing directory", () => {
    expect(() => readAgentMetas(join(mkTmp(), "nope"))).toThrow(ZError);
    expect(() => readAgentMetas(join(mkTmp(), "nope"))).toThrow(/sub-agent transcript directory/);
  });
});

describe("findRootAgents (#190)", () => {
  test("finds the stage agent whose first line carries the tag", () => {
    const dir = mkTmp();
    const { t1 } = twoReviewersWithSkeptics(dir);
    const { metas } = readAgentMetas(dir);
    expect(findRootAgents(dir, t1, metas)).toEqual(["r1"]);
  });

  test("returns nothing for a tag no agent carries", () => {
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    const { metas } = readAgentMetas(dir);
    expect(findRootAgents(dir, spawnTag("zstack", 999, "reviewer", 1), metas)).toEqual([]);
  });

  // The structural half of the filter. A reviewer that pasted its own prompt
  // header into a skeptic brief makes the skeptic match the tag too; attributing
  // a whole stage to one skeptic would be worse than any undercount. Only the
  // orchestrator's own spawns are parentless, so the echoing child is excluded
  // by construction rather than by a heuristic.
  test("excludes a descendant that echoed its parent's tag", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 151, "reviewer", 1);
    writeAgent(dir, "r1", { prompt: stagePromptWithTag(tag) });
    writeAgent(dir, "echo", { parent: "r1", prompt: `Refute this. My parent said: ${stagePromptWithTag(tag)}` });
    const { metas } = readAgentMetas(dir);
    expect(findRootAgents(dir, tag, metas)).toEqual(["r1"]);
  });

  // Only the FIRST line is scanned, and only a bounded prefix of it. A tag that
  // shows up later in a transcript is some other spawn's prompt quoted in a tool
  // result, never this agent's own identity.
  test("ignores the tag when it appears past the first line", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 151, "reviewer", 1);
    writeAgent(dir, "r1", {
      extraLines: [JSON.stringify({ type: "assistant", message: { content: stagePromptWithTag(tag) } })],
    });
    const { metas } = readAgentMetas(dir);
    expect(findRootAgents(dir, tag, metas)).toEqual([]);
  });

  test("ignores the tag when it sits past the bounded first-line prefix", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 151, "reviewer", 1);
    writeAgent(dir, "huge", { prompt: `${"x".repeat(70_000)}\u0020${SPAWN_TAG_MARKER} ${tag}` });
    const { metas } = readAgentMetas(dir);
    expect(findRootAgents(dir, tag, metas)).toEqual([]);
  });
});

describe("descendantsOf (#190)", () => {
  test("walks transitively, sorted, excluding the root", () => {
    const dir = mkTmp();
    writeAgent(dir, "root");
    writeAgent(dir, "kidB", { parent: "root" });
    writeAgent(dir, "kidA", { parent: "root" });
    writeAgent(dir, "grandkid", { parent: "kidA" });
    writeAgent(dir, "unrelated");
    const { metas } = readAgentMetas(dir);
    expect(descendantsOf(metas, "root")).toEqual(["grandkid", "kidA", "kidB"]);
  });

  test("terminates on a cyclic parent chain", () => {
    // The harness should never write this; the visited set means we do not have
    // to trust that it never will -- a cycle must not hang the collect step.
    const metas = [
      { agentId: "a", parentAgentId: "b" },
      { agentId: "b", parentAgentId: "a" },
    ];
    expect(descendantsOf(metas, "a")).toEqual(["b"]);
  });

  test("returns nothing for a leaf", () => {
    const dir = mkTmp();
    writeAgent(dir, "root");
    const { metas } = readAgentMetas(dir);
    expect(descendantsOf(metas, "root")).toEqual([]);
  });
});

// -- #209: the throwaway worktree may not be removed under a live descendant ---
//
// #66's review removed `.worktrees/review-66` while two of its three skeptics
// were still executing inside it -- skeptic 2 reported the worktree disappearing
// from `git worktree list` partway through. Children outlive the stage that
// spawned them, so "the parent returned" is not "the subtree finished". The
// signal is the parentage data collection already walks, never a second liveness
// mechanism and never wall-clock proximity (which was already the wrong answer
// for attribution: sibling reviewers' skeptics interleave in one flat directory).
describe("subtree liveness (#209)", () => {
  const live = (dir: string, root: string) => liveDescendants(dir, readAgentMetas(dir).metas, root, { now: NOW });
  const collect = (dir: string, tag: string, name: string) =>
    collectTranscripts({ subagentsDir: dir, tag, dest: join(mkTmp(), "collected"), name, now: NOW });

  test("AC7: a background skeptic still writing blocks the teardown, ack or no ack", () => {
    const dir = mkTmp();
    const { t1 } = twoReviewersWithSkeptics(dir);
    // The real reviewer shape: all three spawned in the background (so the parent
    // holds three "Async agent launched successfully" acks and nothing else), one
    // returned, two still on a tool call inside `.worktrees/review-<N>`.
    backgroundSkeptics(dir, "r1", ["s1a", "s1b", "s1c"], ["s1a"]);
    expect(live(dir, "r1")).toEqual(["s1b", "s1c"]);
    const r = collect(dir, t1, "reviewer-1");
    expect(r.subtreeDone).toBe(false); // the SKILL's gate: do NOT remove the worktree
    expect(r.live).toEqual(["s1b", "s1c"]);
    // Collection itself is unaffected -- the stage's spend is still attributed.
    expect(r.descendants).toBe(3);
  });

  // The regression QA caught: the spawn-time ack carries the child's tool_use_id,
  // so anything keyed on that id in the parent's file reads EVERY background child
  // as finished the instant it starts -- exactly the #66 removal this prevents.
  test("AC7: the spawn ack alone never counts as a result", () => {
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    for (const s of ["s1a", "s1b", "s1c"]) appendBackgroundAck(dir, "r1", s);
    // Not one skeptic has written a thing yet; the parent already holds all three
    // acks. Every one of them is still running.
    expect(live(dir, "r1")).toEqual(["s1a", "s1b", "s1c"]);
  });

  test("AC8: with every descendant returned and quiet, the subtree is done and removal proceeds", () => {
    const dir = mkTmp();
    const { t1 } = twoReviewersWithSkeptics(dir);
    backgroundSkeptics(dir, "r1", ["s1a", "s1b", "s1c"], ["s1a", "s1b", "s1c"]);
    const r = collect(dir, t1, "reviewer-1");
    expect(r.live).toEqual([]);
    expect(r.subtreeDone).toBe(true);
  });

  // Shape without quiescence is not enough: agents narrate mid-work ("Now I'll
  // write the extraction JSON.") and keep going. 9,632 of the finished-shape
  // records across this machine's 1,388 sub-agent transcripts were NOT the last
  // record in their file.
  test("a final-looking record written seconds ago is still live", () => {
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    appendFinalAnswer(dir, "s1a", RECENT);
    appendFinalAnswer(dir, "s1b", QUIET);
    appendFinalAnswer(dir, "s1c", QUIET);
    expect(live(dir, "r1")).toEqual(["s1a"]);
    // ...and the boundary is the constant, not a guess.
    const metas = readAgentMetas(dir).metas;
    expect(liveDescendants(dir, metas, "r1", { now: Date.parse(RECENT) + SUBTREE_QUIET_MS })).toEqual([]);
    expect(liveDescendants(dir, metas, "r1", { now: Date.parse(RECENT) + SUBTREE_QUIET_MS - 1 })).toEqual(["s1a"]);
  });

  // The quiet window is a measurement, and this is the measurement's gate. The
  // first cut shipped 180s on the strength of an 87-transcript sample whose
  // longest mid-work gap was 94s ("~2x the ceiling"). Re-measured over EVERY
  // sub-agent transcript on this machine -- 1,388 files, 9,632 finished-shape
  // records that were not the last in their file -- the mid-work ceiling is 423s:
  // three real transcripts narrate, go quiet for 202s/303s/423s, then resume with
  // `thinking` or `tool_use`. At 180s each of those, as a skeptic, has
  // `.worktrees/review-<N>` removed out from under it mid-run -- #66 exactly. So
  // the constant must clear the measured ceiling by the same 2x margin the
  // original rule claimed, and this test is what stops it drifting back down: the
  // cost of being long is one worktree Step 7 sweeps anyway.
  test("the quiet window clears the measured mid-work ceiling by 2x", () => {
    expect(MEASURED_MIDWORK_GAP_MS).toBe(423_110);
    expect(SUBTREE_QUIET_MS).toBeGreaterThanOrEqual(2 * MEASURED_MIDWORK_GAP_MS);
    // Each of the three real gaps that break 180s, as a live skeptic.
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    const gaps = [202_000, 303_000, MEASURED_MIDWORK_GAP_MS];
    ["s1a", "s1b", "s1c"].forEach((s, i) => appendFinalAnswer(dir, s, new Date(NOW - gaps[i]).toISOString()));
    expect(live(dir, "r1")).toEqual(["s1a", "s1b", "s1c"]);
  });

  test("a transcript still parked on a tool_use is live however long it has been quiet", () => {
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    // The live-probe shape: blocked on a 70s Bash call, nothing appended since.
    for (const s of ["s1a", "s1b", "s1c"]) appendRunning(dir, s, QUIET);
    expect(live(dir, "r1")).toEqual(["s1a", "s1b", "s1c"]);
  });

  test("a stage with no sub-agents at all is done immediately (every builder/qa/merge)", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 151, "builder", 1);
    writeAgent(dir, "b1", { prompt: stagePromptWithTag(tag) });
    const r = collect(dir, tag, "builder-1");
    expect(r.subtreeDone).toBe(true);
    expect(r.live).toEqual([]);
  });

  test("a sibling reviewer's outstanding skeptics never hold THIS stage's worktree", () => {
    const dir = mkTmp();
    const { t1 } = twoReviewersWithSkeptics(dir);
    backgroundSkeptics(dir, "r1", ["s1a", "s1b", "s1c"], ["s1a", "s1b", "s1c"]);
    // r2's three are all still running, in the same flat directory.
    backgroundSkeptics(dir, "r2", ["s2a", "s2b", "s2c"], []);
    expect(collect(dir, t1, "reviewer-1").subtreeDone).toBe(true);
  });

  test("liveness is transitive: a live grandchild holds the worktree too", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 151, "reviewer", 1);
    writeAgent(dir, "r1", { prompt: stagePromptWithTag(tag) });
    writeAgent(dir, "s1", { parent: "r1" });
    writeAgent(dir, "g1", { parent: "s1" });
    appendFinalAnswer(dir, "s1"); // the skeptic returned; its own sub-agent did not
    appendRunning(dir, "g1");
    expect(live(dir, "r1")).toEqual(["g1"]);
  });

  // Every unreadable input fails toward LIVE, and that direction is free: a kept
  // worktree is swept by the batch-end cleanup, while a removed one destroys the
  // workspace a running agent is reading.
  test("an unreadable, unparseable, or undated transcript reads as live", () => {
    const dir = mkTmp();
    writeAgent(dir, "r1");
    writeAgent(dir, "s1", { parent: "r1" }); // only the spawn prompt so far: no answer
    writeAgent(dir, "s2", { parent: "r1" });
    writeAgent(dir, "s3", { parent: "r1" });
    // A final line the harness is still writing -- truncated JSON IS activity.
    appendFinalAnswer(dir, "s2");
    writeFileSync(join(dir, "agent-s2.jsonl"), readFileSync(join(dir, "agent-s2.jsonl"), "utf8") + '{"type":"assist');
    // A final answer with no usable timestamp: nothing to measure quiet against.
    append(dir, "s3", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    expect(live(dir, "r1")).toEqual(["s1", "s2", "s3"]);
    // A descendant whose transcript file does not exist at all, same answer.
    expect(liveDescendants(dir, [{ agentId: "gone", parentAgentId: "ghost" }], "ghost", { now: NOW })).toEqual(["gone"]);
  });

  // The hole review found in the first cut, reproduced exactly: readAgentMetas
  // SKIPS an unparseable sidecar, so descendantsOf never sees that child and the
  // liveness walk never checked it -- one truncated meta and `subtreeDone` said
  // TRUE with a skeptic 5 seconds into a tool call. The SKILL's gate is
  // `[ "$(jq -r .subtreeDone ...)" = "true" ] && git worktree remove --force`, so
  // that is #66's removal-under-a-live-skeptic with a new trigger, and a
  // half-written meta is likeliest at SPAWN, when the child is youngest.
  test("AC7: an unreadable meta hides a LIVE child, so the subtree is not done", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 66, "reviewer", 1);
    writeAgent(dir, "r1", { prompt: stagePromptWithTag(tag) });
    writeAgent(dir, "s1", { parent: "r1", meta: '{"agentType":"general-pur' }); // truncated mid-write
    appendRunning(dir, "s1"); // last record is a tool_use written 5s ago
    const r = collect(dir, tag, "reviewer-1");
    expect(r.skippedMeta).toEqual(["agent-s1.meta.json"]);
    expect(r.live).toEqual(["s1"]); // the evidence is in the same object, and used
    expect(r.subtreeDone).toBe(false);
  });

  // ...but unknown parentage is not blanket-blocking: the child's OWN transcript
  // is the same evidence agentFinished already reads, and one that has come to
  // rest cannot be holding any worktree, whoever spawned it. Otherwise a single
  // bad sidecar anywhere in a shared directory would wedge every teardown.
  test("an unreadable meta whose agent has come to rest does not block removal", () => {
    const dir = mkTmp();
    const tag = spawnTag("zstack", 66, "reviewer", 1);
    writeAgent(dir, "r1", { prompt: stagePromptWithTag(tag) });
    writeAgent(dir, "s1", { parent: "r1", meta: "{oops" });
    appendFinalAnswer(dir, "s1"); // returned, and quiet since
    const r = collect(dir, tag, "reviewer-1");
    expect(r.skippedMeta).toEqual(["agent-s1.meta.json"]);
    expect(r.live).toEqual([]);
    expect(r.subtreeDone).toBe(true);
  });

  // The batch sweep's question is different from collect's -- "could ANY agent of
  // this session still be reading a review worktree", asked of a directory of
  // leftover checkouts with no stage tag to trace back -- so it ignores parentage
  // entirely, which also makes it immune to the sidecar hole above.
  describe("liveAgentsIn", () => {
    test("names every unfinished agent regardless of parentage, and none when all are quiet", () => {
      const dir = mkTmp();
      writeAgent(dir, "r1");
      writeAgent(dir, "s1", { parent: "r1" });
      writeAgent(dir, "s2", { parent: "r1", meta: "not json at all" });
      appendFinalAnswer(dir, "r1");
      appendRunning(dir, "s1"); // mid tool call
      appendFinalAnswer(dir, "s2", RECENT); // returned, but only 5s ago
      expect(liveAgentsIn(dir, { now: NOW })).toEqual(["s1", "s2"]);
      appendFinalAnswer(dir, "s1");
      appendFinalAnswer(dir, "s2");
      expect(liveAgentsIn(dir, { now: NOW })).toEqual([]);
    });

    // Step 0's case: the harness creates `subagents/` when the session's first
    // sub-agent spawns, so its absence is evidence of none, not a fail-open.
    test("a missing sub-agent directory is no live agents", () => {
      expect(liveAgentsIn(join(mkTmp(), "never-created"))).toEqual([]);
    });

    // The wedge this bound exists for, at the level the operator meets it: ONE
    // agent killed mid-tool-call disabled `sweep-review` and reconcile's
    // throwaway prunes for that whole session, at any age, with no override --
    // and `sweep-review` is what troubleshooting.md sells as the by-hand clear.
    // Measured: 17 of 1,490 sub-agent transcripts on this machine were
    // permanently live that way, across 8 of 114 sessions.
    test("one agent killed mid-tool-call does not wedge the sweep forever", () => {
      const dir = mkTmp();
      writeAgent(dir, "crashed");
      writeAgent(dir, "done");
      appendRunning(dir, "crashed", new Date(NOW - SUBTREE_STALE_MS).toISOString());
      appendTerminalAnswer(dir, "done");
      // One second short of the ceiling it still holds the sweep...
      expect(liveAgentsIn(dir, { now: NOW - 1 })).toEqual(["crashed"]);
      // ...and at it, the sweep runs.
      expect(liveAgentsIn(dir, { now: NOW })).toEqual([]);
      // The operator override, for the session they know is dead.
      expect(liveAgentsIn(dir, { now: NOW - 1, staleMs: 1_000 })).toEqual([]);
    });
  });

  // Why Step 7's sweep can fire at all. It runs seconds after the merge stage
  // returns, scanning the same `subagents/` directory that stage agent lives in,
  // so under shape+quiescence alone every stage agent of the batch read LIVE for
  // 15 minutes and the call could never sweep anything -- theater in the SKILL.
  // A turn-ending stop_reason is the harness saying the agent has no more to
  // write, and it is measured to be unambiguous: 1,310 of this machine's 1,532
  // finished transcripts end on one, and of the 10,517 final-answer-shaped
  // records that were NOT last in their file, ZERO carry one.
  test("a turn-ending stop_reason is proof on its own -- no settling window", () => {
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    appendTerminalAnswer(dir, "s1a", RECENT); // returned 5 seconds ago
    appendTerminalAnswer(dir, "s1b", RECENT, "stop_sequence");
    appendFinalAnswer(dir, "s1c", RECENT); // same shape, stop_reason null: still noisy
    expect(live(dir, "r1")).toEqual(["s1c"]);
  });

  // ...but the fast path is the stop_reason, not the shape: `tool_use` and
  // `max_tokens` both mean more is coming, and both appear on mid-work records in
  // the corpus (44 and 1).
  test("a non-terminal stop_reason still waits out the settling window", () => {
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    appendTerminalAnswer(dir, "s1a", RECENT, "tool_use");
    appendTerminalAnswer(dir, "s1b", RECENT, "max_tokens");
    appendTerminalAnswer(dir, "s1c", QUIET, "tool_use"); // quiet long enough anyway
    expect(live(dir, "r1")).toEqual(["s1a", "s1b"]);
  });

  // The ceiling is a measurement like the window is, and this is its gate. The
  // sample: 135,373 gaps between a NON-final-shaped record (the tool_use an agent
  // is blocked on, the tool_result it just took, a bare thinking chunk) and that
  // agent's next one, over all 1,546 sub-agent transcripts. p50 1.3s, p99 77s, 25
  // over 600s, and one 13,004s Bash call.
  test("the staleness ceiling clears the measured max stall by 2x, and outlasts the quiet window", () => {
    expect(MEASURED_MAX_STALL_MS).toBe(13_003_952);
    expect(SUBTREE_STALE_MS).toBeGreaterThanOrEqual(2 * MEASURED_MAX_STALL_MS);
    // It is the OUTER bound: a shape the quiet window could clear must never be
    // held open by the ceiling instead.
    expect(SUBTREE_STALE_MS).toBeGreaterThan(SUBTREE_QUIET_MS);
    // A skeptic blocked on the longest real stall in the corpus is still live.
    const dir = mkTmp();
    twoReviewersWithSkeptics(dir);
    for (const s of ["s1a", "s1b", "s1c"]) appendRunning(dir, s, new Date(NOW - MEASURED_MAX_STALL_MS).toISOString());
    expect(live(dir, "r1")).toEqual(["s1a", "s1b", "s1c"]);
  });

  // The ceiling has to cover the shapes that carry no usable timestamp too --
  // otherwise the "fails toward LIVE" rule above is a second way to wedge
  // forever. The file's own mtime answers for those, and only for the ceiling:
  // the settling window stays on the record's stamp, so copying a transcript
  // (which collection does) can never make a live agent look finished.
  test("an undated transcript nobody has touched in ages is finished too", () => {
    const dir = mkTmp();
    writeAgent(dir, "r1");
    writeAgent(dir, "s1", { parent: "r1" });
    append(dir, "s1", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    const metas = readAgentMetas(dir).metas;
    expect(liveDescendants(dir, metas, "r1", { now: NOW })).toEqual(["s1"]); // no timestamp: live
    const old = statSync(join(dir, "agent-s1.jsonl")).mtimeMs + SUBTREE_STALE_MS;
    expect(liveDescendants(dir, metas, "r1", { now: old })).toEqual([]);
  });

  // The verdict is in code, but the REMOVAL is the SKILL's, so the ordering is
  // pinned here: collect (which knows the subtree) first, then a teardown gated
  // on its answer -- never a removal keyed on the parent returning.
  test("the SKILL gates the review worktree removal on the collected subtree", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "z-loop", "SKILL.md"), "utf8");
    const has = (s: string) => skill.includes(s); // booleans: a miss must not dump 60KB
    expect(has(`jq -r .subtreeDone "$TMP/collected-<N>.json"`)).toBe(true);
    expect(has(`git worktree remove ".worktrees/review-<N>" --force`)).toBe(true);
    // The unconditional "remove it after the stage" form is what #66 hit.
    expect(has(`remove it after the stage (\`git worktree remove ".worktrees/review-<N>" --force\`)`)).toBe(false);
  });
});

describe("collectTranscripts (#190)", () => {
  test("collects the stage agent plus exactly its own descendants", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const { t1 } = twoReviewersWithSkeptics(dir);
    const r = collectTranscripts({ subagentsDir: dir, tag: t1, dest, name: "reviewer-1" });
    expect(r.root).toBe("r1");
    expect(r.descendants).toBe(3);
    expect(r.files.map((f) => f.file)).toEqual([
      "reviewer-1.jsonl",
      "reviewer-1-sub-s1a.jsonl",
      "reviewer-1-sub-s1b.jsonl",
      "reviewer-1-sub-s1c.jsonl",
    ]);
    expect(readdirSync(dest).sort()).toEqual([
      "reviewer-1-sub-s1a.jsonl",
      "reviewer-1-sub-s1b.jsonl",
      "reviewer-1-sub-s1c.jsonl",
      "reviewer-1.jsonl",
    ]);
  });

  // THE run-10 regression. Both reviewers' skeptics sit in one flat directory
  // with interleaved mtimes; the mtime-window sweep gave one reviewer 8 files.
  test("does NOT collect a sibling reviewer's skeptics from the same flat dir", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const { t1 } = twoReviewersWithSkeptics(dir);
    // Every file written within the same instant, then stamped identical mtimes
    // so wall-clock carries no signal at all.
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const r = collectTranscripts({ subagentsDir: dir, tag: t1, dest, name: "reviewer-1" });
    expect(r.files).toHaveLength(4);
    for (const other of ["r2", "s2a", "s2b", "s2c"]) {
      expect(r.files.map((f) => f.agentId)).not.toContain(other);
    }
  });

  test("copies real content, stage file first", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const { t1 } = twoReviewersWithSkeptics(dir);
    collectTranscripts({ subagentsDir: dir, tag: t1, dest, name: "reviewer-1" });
    expect(readFileSync(join(dest, "reviewer-1.jsonl"), "utf8")).toBe(
      readFileSync(join(dir, "agent-r1.jsonl"), "utf8")
    );
    expect(readFileSync(join(dest, "reviewer-1-sub-s1b.jsonl"), "utf8")).toBe(
      readFileSync(join(dir, "agent-s1b.jsonl"), "utf8")
    );
  });

  // Idempotence is structural, not incidental: naming descendants by agent id
  // rather than a 1..k counter means a late-finishing skeptic cannot shift the
  // other names and leave a stale duplicate behind.
  test("is idempotent, and a late descendant only adds a file", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const { t1 } = twoReviewersWithSkeptics(dir);
    const first = collectTranscripts({ subagentsDir: dir, tag: t1, dest, name: "reviewer-1" });
    const second = collectTranscripts({ subagentsDir: dir, tag: t1, dest, name: "reviewer-1" });
    expect(second).toEqual(first);
    expect(readdirSync(dest)).toHaveLength(4);
    // A skeptic whose id sorts BEFORE the existing ones -- the case a counter
    // would renumber.
    writeAgent(dir, "s1AA", { parent: "r1" });
    const third = collectTranscripts({ subagentsDir: dir, tag: t1, dest, name: "reviewer-1" });
    expect(third.descendants).toBe(4);
    expect(readdirSync(dest).sort()).toEqual([
      "reviewer-1-sub-s1AA.jsonl",
      "reviewer-1-sub-s1a.jsonl",
      "reviewer-1-sub-s1b.jsonl",
      "reviewer-1-sub-s1c.jsonl",
      "reviewer-1.jsonl",
    ]);
  });

  test("collects a lone stage agent with no sub-agents", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const tag = spawnTag("zstack", 151, "builder", 1);
    writeAgent(dir, "b1", { prompt: stagePromptWithTag(tag) });
    const r = collectTranscripts({ subagentsDir: dir, tag, dest, name: "builder-1" });
    expect(r.descendants).toBe(0);
    expect(readdirSync(dest)).toEqual(["builder-1.jsonl"]);
  });

  // Fail loud, not fail open: a silently-missing stage transcript is exactly the
  // undercount #190 filed. Nothing is written, so the failure cannot be mistaken
  // for a partial success.
  test("throws, writing nothing, when no agent carries the tag", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    twoReviewersWithSkeptics(dir);
    expect(() =>
      collectTranscripts({ subagentsDir: dir, tag: spawnTag("zstack", 999, "reviewer", 1), dest, name: "reviewer-1" })
    ).toThrow(/No stage transcript carries spawn tag/);
    expect(() => readdirSync(dest)).toThrow();
  });

  test("throws when one tag matches two orchestrator spawns", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const tag = spawnTag("zstack", 151, "reviewer", 1);
    writeAgent(dir, "r1", { prompt: stagePromptWithTag(tag) });
    writeAgent(dir, "r1dup", { prompt: stagePromptWithTag(tag) });
    expect(() => collectTranscripts({ subagentsDir: dir, tag, dest, name: "reviewer-1" })).toThrow(
      /matches 2 orchestrator-spawned agents/
    );
  });

  test("collects even when the stage agent's own meta is corrupt", () => {
    // The sidecar is only needed to learn PARENTAGE; the stage agent has none,
    // so a corrupt one costs nothing but a stderr line.
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const tag = spawnTag("zstack", 151, "reviewer", 1);
    writeAgent(dir, "r1", { prompt: stagePromptWithTag(tag), meta: "{broken" });
    writeAgent(dir, "s1", { parent: "r1" });
    let r!: ReturnType<typeof collectTranscripts>;
    const err = captureStderr(() => {
      r = collectTranscripts({ subagentsDir: dir, tag, dest, name: "reviewer-1" });
    });
    expect(r.root).toBe("r1");
    expect(r.descendants).toBe(1);
    expect(r.skippedMeta).toEqual(["agent-r1.meta.json"]);
    expect(err).toContain("agent-r1.meta.json");
  });
});

describe("subagentsDirFor (#190)", () => {
  test("derives the sibling directory of the newest session transcript", () => {
    const home = mkTmp();
    const cwd = "D:\\repo\\zstack";
    const projects = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "old-session.jsonl"), "{}\n");
    writeFileSync(join(projects, "new-session.jsonl"), "{}\n");
    utimesSync(join(projects, "old-session.jsonl"), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(projects, "new-session.jsonl"), new Date(2_000_000), new Date(2_000_000));
    expect(subagentsDirFor(cwd, home)).toBe(join(projects, "new-session", "subagents"));
  });

  test("is undefined when no session transcript resolves", () => {
    expect(subagentsDirFor("D:\\repo\\nothing-here", mkTmp())).toBeUndefined();
  });
});

describe("transcripts CLI (#190)", () => {
  test("tag prints the same value the constructors stamp", () => {
    const out = captureStdout(() =>
      expect(main(["tag", "--slug", "zstack", "--ticket", "151", "--stage", "reviewer", "--attempt", "2"])).toBe(0)
    ).trim();
    expect(out).toBe(spawnTag("zstack", 151, "reviewer", 2));
    // The round trip the whole mechanism rests on: the CLI's tag is what the
    // emitted prompt actually carries.
    expect(reviewerPrompt(
      { ticketBody: "b", acceptanceCriteria: "a", diff: "d", worktreePath: "/w" },
      "/tmp/input-151.json",
      true,
      out
    )).toContain(`${SPAWN_TAG_MARKER} ${out}`);
  });

  // A typo'd stage mints a valid-looking tag whose collected files then bucket
  // under "other" in the spend-by-stage table -- the reviewer's dollars quietly
  // leaving the reviewer row. Rejected at the source instead.
  test("tag rejects a stage with no spend-by-stage row", () => {
    const err = captureStderr(() =>
      expect(main(["tag", "--slug", "z", "--ticket", "1", "--stage", "revewier", "--attempt", "1"])).toBe(1)
    );
    expect(err).toContain("--stage must be one of builder, qa, reviewer, merge");
    for (const stage of ["builder", "qa", "reviewer", "merge"]) {
      captureStdout(() =>
        expect(main(["tag", "--slug", "z", "--ticket", "1", "--stage", stage, "--attempt", "1"])).toBe(0)
      );
    }
  });

  // The two lists this change now depends on agreeing: lib/cost.ts prices
  // against KNOWN_STAGES, lib/loop.ts schedules against Stage. They were already
  // separate copies before #190; pin them equal so the tag verb's validation and
  // the spend table can never disagree about what a stage is.
  test("cost.ts's KNOWN_STAGES is exactly lib/loop.ts's set of stages", () => {
    expect([...KNOWN_STAGES].sort()).toEqual(Object.keys(STATUS_FOR_STAGE).sort());
  });

  test("tag rejects a non-integer ticket or attempt", () => {
    const err = captureStderr(() =>
      expect(main(["tag", "--slug", "z", "--ticket", "abc", "--stage", "qa", "--attempt", "1"])).toBe(1)
    );
    expect(err).toContain("--ticket must be a positive integer");
    const err2 = captureStderr(() =>
      expect(main(["tag", "--slug", "z", "--ticket", "1", "--stage", "qa", "--attempt", "0"])).toBe(1)
    );
    expect(err2).toContain("--attempt must be a positive integer");
  });

  test("collect writes the files and prints a JSON manifest", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    const { t1 } = twoReviewersWithSkeptics(dir);
    const out = captureStdout(() =>
      expect(
        main(["collect", "--tag", t1, "--dest", dest, "--name", "reviewer-1", "--subagents-dir", dir])
      ).toBe(0)
    );
    const manifest = JSON.parse(out);
    expect(manifest.root).toBe("r1");
    expect(manifest.descendants).toBe(3);
    expect(manifest.files).toHaveLength(4);
    expect(readdirSync(dest)).toHaveLength(4);
    // #209: the teardown gate is `jq -r .subtreeDone` over this exact payload, so
    // the key has to be here and has to be a bare boolean. Nothing in this fixture
    // has returned, so the honest answer is "still running".
    expect(manifest.subtreeDone).toBe(false);
    expect(manifest.live).toEqual(["s1a", "s1b", "s1c"]);
  });

  test("collect exits 1 with the reason when the tag matches nothing", () => {
    const dir = mkTmp();
    const dest = join(mkTmp(), "ticket-151");
    twoReviewersWithSkeptics(dir);
    const err = captureStderr(() =>
      expect(
        main([
          "collect",
          "--tag",
          spawnTag("zstack", 999, "reviewer", 1),
          "--dest",
          dest,
          "--name",
          "reviewer-1",
          "--subagents-dir",
          dir,
        ])
      ).toBe(1)
    );
    expect(err).toContain("No stage transcript carries spawn tag");
    expect(err).toContain("reviewer-1");
  });

  test("collect says to pass --subagents-dir when the session cannot be resolved", () => {
    const err = captureStderr(() =>
      expect(
        main(["collect", "--tag", "zs-deadbeefcafe", "--dest", mkTmp(), "--name", "qa-1", "--project-dir", join(mkTmp(), "no-such-repo")])
      ).toBe(1)
    );
    expect(err).toContain("--subagents-dir");
  });

  test("bare invocation prints usage and exits 1", () => {
    const out = captureStdout(() => expect(main([])).toBe(1));
    expect(out).toContain("transcripts <command>");
  });
});
