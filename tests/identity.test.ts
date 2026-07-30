// Gate tests for lib/identity.ts (issue #66): the config read/write for the
// owner's recorded bot-vs-human-account choice. Per the ticket's Tests +
// evals section, this covers the one thing that has to be code rather than
// prose -- a project with no choice, one that chose bot, and one that chose
// human-account must resolve to three distinct states, and the "already
// chosen" state must not look like "unset" on a later read (the deterministic
// contract z-setup's AC5/AC7 and z-update's AC6 build their "don't
// re-prompt" behavior on). All deterministic, no network, no gh calls --
// well under the 2s gate budget.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identityState,
  main,
  recordIdentityChoice,
  type IdentityState,
} from "../lib/identity.ts";
import { configPath, type BoardConfig } from "../lib/config.ts";

// -- fixtures -----------------------------------------------------------------
const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function minimalConfig(slug: string, extra: Partial<BoardConfig> = {}): BoardConfig {
  return {
    slug,
    owner: "acme",
    repo: slug,
    projectNumber: 1,
    projectId: "PVT_1",
    repositoryId: "R_1",
    statusField: {
      id: "F_status",
      dataType: "SINGLE_SELECT",
      options: { Backlog: "o1", Ready: "o2", Done: "o3" },
    },
    fields: {},
    ...extra,
  };
}

// Writes a config.json for `slug` under a fresh temp $HOME and returns that
// home dir. Mirrors tests/setup.test.ts's testHome()/tests/throttle.test.ts's
// makeConfigHome() shape.
function makeHome(slug: string, extra: Partial<BoardConfig> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "zstack-identity-home-"));
  homes.push(home);
  const dir = join(home, ".zstack", "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(minimalConfig(slug, extra)));
  return home;
}

function readConfig(home: string, slug: string): any {
  return JSON.parse(readFileSync(configPath(slug, home), "utf8"));
}

// ============================================================================
// identityState: pure, three distinct states
// ============================================================================
describe("identityState", () => {
  test("no identity block -> \"unset\"", () => {
    expect(identityState({})).toBe("unset");
    expect(identityState({ identity: undefined })).toBe("unset");
  });

  test("mode \"bot\" -> \"bot\"", () => {
    expect(identityState({ identity: { mode: "bot", recordedAt: "2026-07-29T00:00:00.000Z" } })).toBe(
      "bot"
    );
  });

  test("mode \"human\" -> \"human\"", () => {
    expect(
      identityState({ identity: { mode: "human", recordedAt: "2026-07-29T00:00:00.000Z" } })
    ).toBe("human");
  });

  test("the three states are pairwise distinct", () => {
    const states: IdentityState[] = [
      identityState({}),
      identityState({ identity: { mode: "bot", recordedAt: "t" } }),
      identityState({ identity: { mode: "human", recordedAt: "t" } }),
    ];
    expect(new Set(states).size).toBe(3);
  });
});

// ============================================================================
// recordIdentityChoice: the write path
// ============================================================================
describe("recordIdentityChoice", () => {
  test("throws a ZError naming the path when no config.json exists for the slug", () => {
    const home = mkdtempSync(join(tmpdir(), "zstack-identity-home-"));
    homes.push(home);
    expect(() => recordIdentityChoice("nope", { mode: "bot" }, home)).toThrow(
      /No zstack config for "nope"/
    );
  });

  test("throws a ZError naming the path when config.json is not valid JSON", () => {
    const home = makeHome("demo");
    writeFileSync(configPath("demo", home), "{ not valid json");
    expect(() => recordIdentityChoice("demo", { mode: "bot" }, home)).toThrow(
      /not valid JSON/
    );
  });

  test("writes mode + recordedAt (injected clock) + tokenLocation, preserving every sibling field", () => {
    const home = makeHome("demo", { maxLanes: 5, quota: { threshold: 250, mode: "abort" } });
    const result = recordIdentityChoice(
      "demo",
      { mode: "bot", tokenLocation: "GH_TOKEN env var in the loop's launch script", now: () => "2026-07-29T12:00:00.000Z" },
      home
    );

    expect(result.identity).toEqual({
      mode: "bot",
      recordedAt: "2026-07-29T12:00:00.000Z",
      tokenLocation: "GH_TOKEN env var in the loop's launch script",
    });
    // Every sibling field survives untouched -- this is a PATCH, not a rewrite.
    expect(result.maxLanes).toBe(5);
    expect(result.quota).toEqual({ threshold: 250, mode: "abort" });
    expect(result.owner).toBe("acme");

    const onDisk = readConfig(home, "demo");
    expect(onDisk.identity).toEqual(result.identity);
    expect(onDisk.maxLanes).toBe(5);
  });

  test('mode "human" with no tokenLocation omits the key entirely (not null, not empty string)', () => {
    const home = makeHome("demo");
    const result = recordIdentityChoice("demo", { mode: "human", now: () => "2026-07-29T12:00:00.000Z" }, home);
    expect(result.identity).toEqual({ mode: "human", recordedAt: "2026-07-29T12:00:00.000Z" });
    expect("tokenLocation" in result.identity!).toBe(false);
    const onDisk = readConfig(home, "demo");
    expect("tokenLocation" in onDisk.identity).toBe(false);
  });

  test("re-recording overwrites a prior choice (switching branches later is supported)", () => {
    const home = makeHome("demo");
    recordIdentityChoice("demo", { mode: "human", now: () => "2026-07-29T00:00:00.000Z" }, home);
    const second = recordIdentityChoice(
      "demo",
      { mode: "bot", tokenLocation: "gh auth login (bot profile)", now: () => "2026-07-30T00:00:00.000Z" },
      home
    );
    expect(second.identity).toEqual({
      mode: "bot",
      recordedAt: "2026-07-30T00:00:00.000Z",
      tokenLocation: "gh auth login (bot profile)",
    });
  });

  test("re-validates before writing: an invalid mode (bypassing the CLI/TS guard) throws and never reaches disk", () => {
    const home = makeHome("demo");
    const before = readFileSync(configPath("demo", home), "utf8");
    expect(() =>
      recordIdentityChoice("demo", { mode: "sometimes" as any }, home)
    ).toThrow(/identity\.mode.*"bot" or "human"/);
    // Nothing was written -- validateConfig throws before atomicWrite runs.
    expect(readFileSync(configPath("demo", home), "utf8")).toBe(before);
  });

  test("defaults to the real clock when no `now` is injected", () => {
    const home = makeHome("demo");
    const before = Date.now();
    const result = recordIdentityChoice("demo", { mode: "bot" }, home);
    const recordedMs = new Date(result.identity!.recordedAt).getTime();
    expect(recordedMs).toBeGreaterThanOrEqual(before);
    expect(recordedMs).toBeLessThanOrEqual(Date.now());
  });
});

// ============================================================================
// main(): the CLI z-setup/SKILL.md and z-update/SKILL.md actually call
// ============================================================================
describe('main("state"): three distinct states via the real CLI path (ticket #66 Tests+evals)', () => {
  test("unset, bot, and human each print their own state, undisturbed by each other", async () => {
    const unsetHome = makeHome("unset-proj");
    const botHome = makeHome("bot-proj");
    recordIdentityChoice("bot-proj", { mode: "bot" }, botHome);
    const humanHome = makeHome("human-proj");
    recordIdentityChoice("human-proj", { mode: "human" }, humanHome);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      await main(["state", "--slug", "unset-proj"], unsetHome);
      await main(["state", "--slug", "bot-proj"], botHome);
      await main(["state", "--slug", "human-proj"], humanHome);
    } finally {
      console.log = origLog;
    }
    expect(logs.map((l) => JSON.parse(l).state)).toEqual(["unset", "bot", "human"]);
  });
});

describe('main("record"): CLI flag wiring', () => {
  test("records bot + token-location and prints the resulting state", async () => {
    const home = makeHome("demo");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => logs.push(s);
    let code: number;
    try {
      code = await main(
        ["record", "--slug", "demo", "--mode", "bot", "--token-location", "GH_TOKEN env var"],
        home
      );
    } finally {
      console.log = origLog;
    }
    expect(code).toBe(0);
    expect(JSON.parse(logs[0])).toEqual({ state: "bot" });
    expect(readConfig(home, "demo").identity.tokenLocation).toBe("GH_TOKEN env var");
  });

  test("rejects a bad --mode with a clear, non-zero-exit error", async () => {
    const home = makeHome("demo");
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (s: string) => errs.push(s);
    let code: number;
    try {
      code = await main(["record", "--slug", "demo", "--mode", "owner"], home);
    } finally {
      console.error = origErr;
    }
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/--mode must be "bot" or "human"/);
    // Nothing was recorded.
    expect(readConfig(home, "demo").identity).toBeUndefined();
  });
});

// ============================================================================
// The "already chosen does not re-prompt" contract (AC6/AC7): once recorded,
// repeated reads keep returning the SAME state -- never reverting to "unset"
// -- which is the deterministic guarantee z-setup/SKILL.md and
// z-update/SKILL.md's "only ask when state === unset" prose depends on.
// ============================================================================
describe("already-chosen states are stable across repeated reads (AC6/AC7)", () => {
  test("state stays \"bot\" across repeated state calls with no re-record in between", async () => {
    const home = makeHome("demo");
    recordIdentityChoice("demo", { mode: "bot" }, home);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      await main(["state", "--slug", "demo"], home);
      await main(["state", "--slug", "demo"], home);
      await main(["state", "--slug", "demo"], home);
    } finally {
      console.log = origLog;
    }
    expect(logs.map((l) => JSON.parse(l).state)).toEqual(["bot", "bot", "bot"]);
  });

  test("state stays \"human\" the same way, and is distinguishable from \"unset\" on the very next read", async () => {
    const home = makeHome("demo");
    expect(identityState(readConfig(home, "demo"))).toBe("unset");
    recordIdentityChoice("demo", { mode: "human" }, home);
    expect(identityState(readConfig(home, "demo"))).toBe("human");
  });
});

// ============================================================================
// SKILL.md prose regressions surfaced by QA on the #66 rebuild pass. These
// are procedure-text bugs, not lib code -- the underlying primitives above
// already proved switching works (recordIdentityChoice overwrites a prior
// choice); what QA caught was the SKILL.md guided procedures never invoking
// that support, or a decision recorded with no real human interaction at
// all. Same read-the-shipped-file style as tests/board.test.ts's F5 gh-
// invocation scanner and tests/plan-schema.test.ts's section() pins.
// ============================================================================
describe("SKILL.md prose regressions (issue #66 QA bounce)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }
  function skillFile(rel: string): string {
    return readFileSync(join(REPO_ROOT, rel), "utf8");
  }

  test("z-update/SKILL.md's Step 2 never stands a bash variable in for the owner's answer", () => {
    // The exact bug: `if [ "$OWNER_ANSWER" = "bot" ]` inside a FENCED bash
    // block, where $OWNER_ANSWER was assigned nowhere, so the else branch
    // fired unconditionally and recorded "human" with zero human
    // interaction. Fenced code is what actually runs, so that's what this
    // checks; the name is still allowed to appear in prose describing the
    // historical bug (it does, deliberately, a few lines above Step 2's
    // fences).
    const content = skillFile("z-update/SKILL.md");
    const fencedBlocks = [...content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(fencedBlocks.length).toBeGreaterThan(0); // canary: the scan must find Step 2's fences
    for (const block of fencedBlocks) {
      expect(block).not.toContain("OWNER_ANSWER");
    }
  });

  test("z-setup/SKILL.md's Step 7 has a branch that offers to switch a recorded 'human' choice to 'bot' once the active gh login has moved off the owner", () => {
    const step7 = section(skillFile("z-setup/SKILL.md"), "## Step 7");
    expect(step7).toMatch(
      /\[\s*"\$STATE"\s*=\s*"human"\s*\]\s*&&\s*\[\s*"\$CURRENT_LOGIN"\s*!=\s*"\$OWNER"\s*\]/
    );
    // The switch is confirmed, never silent -- distinguishes a real bot login
    // from a different personal account temporarily authenticated.
    expect(step7).toContain("AskUserQuestion");
  });

  test("no file still points 'Step 7' readers at the auto-approvals step (renumbered to Step 8 by this ticket)", () => {
    // Each of these three files' only prior "Step 7" mention was the stale
    // auto-approvals cross-reference (confirmed by a full-repo grep during
    // the rebuild) -- so "contains no 'Step 7' at all" is a precise
    // regression guard here, not an over-broad one.
    for (const rel of ["README.md", "z-uninstall/SKILL.md", "docs/user-guide/z-uninstall.md"]) {
      expect(skillFile(rel)).not.toMatch(/Step 7\b/);
    }
  });
});
