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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZError } from "../lib/config.ts";
import { KNOWN_STAGES } from "../lib/cost.ts";
import { STATUS_FOR_STAGE } from "../lib/loop.ts";
import { SPAWN_TAG_MARKER, builderPrompt, reviewerPrompt } from "../lib/stage-prompts.ts";
import {
  collectTranscripts,
  descendantsOf,
  findRootAgents,
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
