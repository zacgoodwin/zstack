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
import { dirname, join } from "node:path";
import {
  identityState,
  main,
  recordIdentityChoice,
  type IdentityState,
} from "../lib/identity.ts";
import { configPath, type BoardConfig } from "../lib/config.ts";
import { toPosixPath } from "./helpers/setup-harness.ts";

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

// Issue #66 review finding 2: both SKILL.md call sites piped this command's
// JSON output through `jq -r .state` to read one field, but `jq` isn't a
// checked prerequisite of this pack (only gstack/bun/gh are) -- a missing or
// failing jq made a real state indistinguishable from a silent read
// failure. --raw removes the dependency entirely for this need: the bare
// word, no JSON, nothing to parse.
describe('main("state --raw"): plain-word output, no JSON, no jq needed', () => {
  test("prints the bare word for each of the three states", async () => {
    const unsetHome = makeHome("unset-proj");
    const botHome = makeHome("bot-proj");
    recordIdentityChoice("bot-proj", { mode: "bot" }, botHome);
    const humanHome = makeHome("human-proj");
    recordIdentityChoice("human-proj", { mode: "human" }, humanHome);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      await main(["state", "--slug", "unset-proj", "--raw"], unsetHome);
      await main(["state", "--slug", "bot-proj", "--raw"], botHome);
      await main(["state", "--slug", "human-proj", "--raw"], humanHome);
    } finally {
      console.log = origLog;
    }
    // No JSON.parse anywhere -- the bare word IS the whole line.
    expect(logs).toEqual(["unset", "bot", "human"]);
  });

  test("a failure (e.g. no config for the slug) still exits non-zero and prints to stderr, same as the JSON form", async () => {
    const home = mkdtempSync(join(tmpdir(), "zstack-identity-home-"));
    homes.push(home);
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (s: string) => errs.push(s);
    let code: number;
    try {
      code = await main(["state", "--slug", "nope", "--raw"], home);
    } finally {
      console.error = origErr;
    }
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/No zstack config for "nope"/);
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
// Shared SKILL.md / bash fixtures, module scope so both the static prose
// checks below and the executable proofs further down (issue #66 review)
// can use the same extraction. Same read-the-shipped-file style as
// tests/board.test.ts's F5 gh-invocation scanner and
// tests/plan-schema.test.ts's section() pins.
// ============================================================================
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
// Every fenced code block's inner text, in document order -- what actually
// runs when an agent follows the skill (bare prose between fences never does).
function fencedBlocksOf(md: string): string[] {
  return [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// SKILL.md prose blocks are bash an AGENT runs, not a checked-in script, so
// proving a fix is more than "the right string appears" means extracting the
// exact shipped fence and executing it for real, with `gh`/`bun` stubbed as
// shell functions (which shadow a PATH lookup in the same script -- no PATH
// wiring needed for them). Only `ls` inside the loop needs a real PATH entry.
const BASH = Bun.which("bash");
if (!BASH) throw new Error("bash not found on PATH: required to execute extracted SKILL.md bash blocks");
function binDir(name: string): string {
  const resolved = Bun.which(name);
  if (!resolved) throw new Error(`${name} not found on PATH: required to execute extracted SKILL.md bash blocks`);
  return toPosixPath(dirname(resolved));
}
const CORE_DIR = binDir("uname"); // ls, etc.

function runBash(script: string, env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const childEnv: Record<string, string> = { PATH: CORE_DIR, ...env };
  for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v && !(key in childEnv)) childEnv[key] = v;
  }
  const proc = Bun.spawnSync([BASH!, "-c", script], { env: childEnv });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode ?? -1 };
}

// ============================================================================
// SKILL.md prose regressions surfaced by QA on the #66 rebuild pass. These
// are procedure-text bugs, not lib code -- the underlying primitives above
// already proved switching works (recordIdentityChoice overwrites a prior
// choice); what QA caught was the SKILL.md guided procedures never invoking
// that support, or a decision recorded with no real human interaction at
// all.
// ============================================================================
describe("SKILL.md prose regressions (issue #66 QA bounce)", () => {
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

// ============================================================================
// Reviewer findings on issue #66 (confidence=0, skeptics=2/3) -- both BLOCKS.
//
// Finding 1 (AC3): z-setup/SKILL.md Step 7 compared $CURRENT_LOGIN to $OWNER
// to detect identity drift on re-runs -- correct on a personal repo ($OWNER
// IS the human owner's own login) but broken on an org-owned repo ($OWNER is
// the org's slug, which no individual human can ever authenticate as): a
// "human" project got re-nagged on every single re-run, and a "bot" project
// whose token had fallen back to a human login got a false "No changes".
//
// Finding 2 (AC6): z-update/SKILL.md Step 2 piped identity.ts's JSON output
// through `jq`, which is not a checked prerequisite of this pack (only
// gstack/bun/gh are) -- a missing jq, a bun error, or a corrupt config.json
// all suppressed to `2>/dev/null` left $STATE empty, which never matched
// "unset" and was never echoed: a real failure was silently indistinguishable
// from "already answered", forever, with nothing surfaced.
//
// The reviewer's own closing note is that this exact surface (SKILL.md bash
// an agent runs, not lib/*.ts) "has no executable test coverage by
// construction... which is why both a QA pass and two skeptics keep finding
// defects there" -- so each fix below is proven two ways: a static
// structural pin (fast, documents intent) AND an EXECUTABLE proof that
// spawns real bash against the exact fenced block extracted from the shipped
// file, with `gh`/`bun` stubbed out. A regex pin alone would repeat the gap
// the reviewer named.
// ============================================================================
describe("issue #66 review finding 1: z-setup Step 7's org-repo identity check", () => {
  function verifyBlock(): string {
    const step7 = section(skillFile("z-setup/SKILL.md"), "## Step 7");
    const block = fencedBlocksOf(step7).find((f) => f.includes("IS_ORG="));
    if (!block) throw new Error("Step 7's CURRENT_LOGIN/IS_ORG verification fence not found");
    return block;
  }

  test("isInOrganization is checked before the STATE=bot/human comparisons (static ordering pin)", () => {
    const block = verifyBlock();
    const orgIdx = block.indexOf('if [ "$IS_ORG" = "true" ]');
    const botIdx = block.indexOf('[ "$STATE" = "bot" ] && [ "$CURRENT_LOGIN" = "$OWNER" ]');
    const humanIdx = block.indexOf('[ "$STATE" = "human" ] && [ "$CURRENT_LOGIN" != "$OWNER" ]');
    expect(orgIdx).toBeGreaterThan(-1);
    expect(botIdx).toBeGreaterThan(-1);
    expect(humanIdx).toBeGreaterThan(-1);
    // Must be an `if` (not a later `elif`), and must precede both broken
    // comparisons -- otherwise an org repo can still reach one of them.
    expect(orgIdx).toBeLessThan(botIdx);
    expect(orgIdx).toBeLessThan(humanIdx);
  });

  test("the org-repo branch is a plain echo, never a question (must not re-nag every re-run)", () => {
    expect(verifyBlock()).not.toContain("AskUserQuestion");
  });

  test("docs/user-guide/bot-identity.md documents the org caveat (review: grep for org/organization previously returned nothing)", () => {
    const doc = skillFile("docs/user-guide/bot-identity.md");
    expect(doc).toMatch(/organization|org-owned/i);
  });

  test("EXECUTABLE: an org-repo 'bot' identity that fell back to a human login gets an honest notice, never the false \"No changes\"", () => {
    const script = `
gh() {
  case "$*" in
    "api user -q .login") echo "$FAKE_LOGIN" ;;
    "repo view --json isInOrganization -q .isInOrganization") echo "$FAKE_IS_ORG" ;;
    *) echo "unexpected gh call: $*" >&2; exit 99 ;;
  esac
}
${verifyBlock()}
`;
    const out = runBash(script, { STATE: "bot", OWNER: "acme-corp", FAKE_LOGIN: "alice", FAKE_IS_ORG: "true" });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Org-owned repo");
    expect(out.stdout).not.toContain("No changes");
    expect(out.stdout).not.toContain("WARNING: config.json records a bot identity");
  });

  test("EXECUTABLE: an org-repo already-answered 'human' project is never re-nagged", () => {
    const script = `
gh() {
  case "$*" in
    "api user -q .login") echo "$FAKE_LOGIN" ;;
    "repo view --json isInOrganization -q .isInOrganization") echo "$FAKE_IS_ORG" ;;
    *) echo "unexpected gh call: $*" >&2; exit 99 ;;
  esac
}
${verifyBlock()}
`;
    // Two different active humans, neither of which is (or ever could be)
    // the org slug -- both must land on the same honest org notice, never
    // the old "confirm below before switching" nag.
    for (const login of ["alice", "bob"]) {
      const out = runBash(script, { STATE: "human", OWNER: "acme-corp", FAKE_LOGIN: login, FAKE_IS_ORG: "true" });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("Org-owned repo");
      expect(out.stdout).not.toContain("confirm below before switching");
    }
  });

  test("EXECUTABLE: personal-repo behavior is unchanged -- the bot-regression warning still fires", () => {
    const script = `
gh() {
  case "$*" in
    "api user -q .login") echo "$FAKE_LOGIN" ;;
    "repo view --json isInOrganization -q .isInOrganization") echo "$FAKE_IS_ORG" ;;
    *) echo "unexpected gh call: $*" >&2; exit 99 ;;
  esac
}
${verifyBlock()}
`;
    const out = runBash(script, { STATE: "bot", OWNER: "zacgoodwin", FAKE_LOGIN: "zacgoodwin", FAKE_IS_ORG: "false" });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("WARNING: config.json records a bot identity");
    expect(out.stdout).not.toContain("Org-owned repo");
  });

  test("EXECUTABLE: personal-repo behavior is unchanged -- the human-switch-offer still fires, and the stable case still says 'No changes'", () => {
    const script = `
gh() {
  case "$*" in
    "api user -q .login") echo "$FAKE_LOGIN" ;;
    "repo view --json isInOrganization -q .isInOrganization") echo "$FAKE_IS_ORG" ;;
    *) echo "unexpected gh call: $*" >&2; exit 99 ;;
  esac
}
${verifyBlock()}
`;
    const switchOut = runBash(script, { STATE: "human", OWNER: "zacgoodwin", FAKE_LOGIN: "the-bot", FAKE_IS_ORG: "false" });
    expect(switchOut.stdout).toContain("confirm below before switching");
    expect(switchOut.stdout).not.toContain("Org-owned repo");

    const stableOut = runBash(script, { STATE: "human", OWNER: "zacgoodwin", FAKE_LOGIN: "zacgoodwin", FAKE_IS_ORG: "false" });
    expect(stableOut.stdout).toContain("No changes");
  });

  // AC7's own scenario, and the one combination the four cases above leave
  // out: a PERSONAL repo that recorded "bot", with `gh` genuinely authed AS
  // the bot -- i.e. STATE="bot" and CURRENT_LOGIN != $OWNER. The only other
  // STATE="bot" case sets the login EQUAL to $OWNER, which is the drift
  // branch, not this stable one. Three review skeptics agreed the shipped
  // if/elif chain reaches the right `else` here, but all three reached that
  // by hand-tracing; AC7 asks for "verifies ... and reports so, changing
  // nothing", so it gets executed like every sibling branch rather than
  // trusted by symmetry.
  test("EXECUTABLE (AC7): a personal repo recorded 'bot' and authed AS the bot reports 'No changes' and asks nothing", () => {
    const script = `
gh() {
  case "$*" in
    "api user -q .login") echo "$FAKE_LOGIN" ;;
    "repo view --json isInOrganization -q .isInOrganization") echo "$FAKE_IS_ORG" ;;
    *) echo "unexpected gh call: $*" >&2; exit 99 ;;
  esac
}
${verifyBlock()}
`;
    const out = runBash(script, {
      STATE: "bot",
      OWNER: "zacgoodwin",
      FAKE_LOGIN: "zstack-loop-bot",
      FAKE_IS_ORG: "false",
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("No changes");
    // Idempotent: it reports, and does not take (or offer) any action.
    expect(out.stdout).not.toContain("WARNING: config.json records a bot identity");
    expect(out.stdout).not.toContain("confirm below before switching");
    expect(out.stdout).not.toContain("Org-owned repo");
    // And it names the login it actually verified, so the report is evidence
    // rather than an unconditional reassurance.
    expect(out.stdout).toContain("zstack-loop-bot");
  });
});

describe("issue #66 review finding 2: z-update Step 2 no longer silently swallows a state-read failure", () => {
  function loopBlock(): string {
    const step2 = section(skillFile("z-update/SKILL.md"), "## Step 2");
    const block = fencedBlocksOf(step2).find((f) => f.includes("for SLUG in"));
    if (!block) throw new Error("Step 2's enumeration fence not found");
    return block;
  }

  test("the enumeration no longer invokes jq and reads --raw output (static pin: jq is not a checked prerequisite of this pack)", () => {
    const block = loopBlock();
    // "jq" may still appear in the explanatory comment (the historical bug);
    // what must be gone is an actual pipe INTO the jq command.
    expect(block).not.toMatch(/\|\s*jq\b/);
    expect(block).toContain("--raw");
  });

  test("a non-zero exit from the state read is captured and warned about, not swallowed (static pin)", () => {
    const block = loopBlock();
    expect(block).toContain("CODE=$?");
    expect(block).toMatch(/\$CODE"\s*-ne\s*0/);
    expect(block).toContain("WARN:");
    // The `ls ... 2>/dev/null` on the for-loop header is fine (an empty/
    // missing projects dir is a normal, silent no-op); what must be gone is
    // suppressing the STATE= read's own stderr the way the old
    // `2>/dev/null | jq ... 2>/dev/null` pipeline did.
    expect(block).not.toMatch(/--raw[^\n]*2>\/dev\/null/);
  });

  test("EXECUTABLE: a slug whose state can't be read is warned about on stderr, and is neither raised nor treated as already-answered", () => {
    const home = mkdtempSync(join(tmpdir(), "zstack-identity-step2-home-"));
    homes.push(home);
    for (const slug of ["proj-unset", "proj-bot", "proj-human", "proj-broken"]) {
      mkdirSync(join(home, ".zstack", "projects", slug), { recursive: true });
    }
    const script = `
HOME="${toPosixPath(home)}"
bun() {
  case "$4" in
    proj-unset) echo "unset" ;;
    proj-bot) echo "bot" ;;
    proj-human) echo "human" ;;
    proj-broken) echo "Config at $HOME/.zstack/projects/proj-broken/config.json is not valid JSON: Unexpected token" >&2; return 1 ;;
    *) echo "unexpected slug: $4" >&2; return 98 ;;
  esac
}
${loopBlock()}
`;
    // Not asserting out.code here: the loop's last statement is
    // `[ "$STATE" = "unset" ] && echo "$SLUG"`, so the SCRIPT's own exit
    // status is just whichever slug `ls` happens to enumerate last matching
    // or not -- a shell idiom artifact, not part of Step 2's contract (the
    // agent reads stdout/stderr, never this loop's exit code). Pre-existing
    // shape, unrelated to this fix.
    const out = runBash(script);
    const raised = out.stdout.split(/\r?\n/).filter(Boolean);
    // Only the genuinely-unset project is raised -- not bot, not human, and
    // NOT the broken one (the exact bug: a read failure used to look exactly
    // like "already answered" and vanish from this list forever).
    expect(raised).toEqual(["proj-unset"]);
    expect(out.stderr).toMatch(/WARN.*proj-broken/);
    expect(out.stdout).not.toContain("proj-broken");
  });

  test("EXECUTABLE: a clean run with every project already answered raises nothing and warns nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "zstack-identity-step2-home-"));
    homes.push(home);
    for (const slug of ["proj-bot", "proj-human"]) {
      mkdirSync(join(home, ".zstack", "projects", slug), { recursive: true });
    }
    const script = `
HOME="${toPosixPath(home)}"
bun() {
  case "$4" in
    proj-bot) echo "bot" ;;
    proj-human) echo "human" ;;
    *) echo "unexpected slug: $4" >&2; return 98 ;;
  esac
}
${loopBlock()}
`;
    // Not asserting out.code here either -- see the note in the previous
    // test; with only "bot"/"human" slugs the last `[ ... ] && echo` is
    // always false, so the script legitimately exits 1 even though nothing
    // is wrong. stdout/stderr are the real assertions.
    const out = runBash(script);
    expect(out.stdout.trim()).toBe("");
    expect(out.stderr.trim()).toBe("");
  });
});

// ============================================================================
// AC5 requires more than "both branches are offered": choosing "continue as
// the human's account" must STATE the #204 consequence (the fold-in gate
// cannot fire) before the choice is accepted. z-setup/SKILL.md does say it,
// but nothing pinned it -- `grep -rn "204" tests/` returned zero hits, so a
// future edit tightening that decision brief could silently drop the one
// sentence AC5 is about. This is a prose-content requirement, so a content
// assertion is the right (and only) instrument.
// ============================================================================
describe("issue #66 AC5: the human-account branch states its #204 cost before being accepted", () => {
  test("z-setup/SKILL.md Step 7's decision brief names #204 and what it costs", () => {
    const step7 = section(skillFile("z-setup/SKILL.md"), "## Step 7");
    expect(step7).toContain("#204");
    // Not just the bare issue number: the brief has to say what goes wrong,
    // in terms an owner can act on. The gate cannot see a human comment
    // while the loop shares that human's login.
    expect(step7).toMatch(/fold-in gate|standing instruction/i);
    expect(step7).toMatch(/invisible to the planning pass/i);
  });

  test("the #204 cost sits in the SAME decision brief that offers the human branch, not in unrelated prose", () => {
    // Guards the failure mode the assertion above can't see on its own: the
    // sentence surviving somewhere in Step 7 while the actual choice text
    // loses it. Both must live in one block.
    const step7 = section(skillFile("z-setup/SKILL.md"), "## Step 7");
    const brief = fencedBlocksOf(step7).find((f) => f.includes("D3 —"));
    if (!brief) throw new Error("Step 7's D3 decision brief fence not found");
    expect(brief).toContain("#204");
    expect(brief).toMatch(/Continue as your own account|continue as human/i);
  });

  test("docs/user-guide/bot-identity.md states the same cost for readers who arrive there first", () => {
    const page = skillFile("docs/user-guide/bot-identity.md");
    expect(page).toContain("#204");
    expect(page).toMatch(/invisible to the loop|fold-in gate/i);
  });
});

// ============================================================================
// Issue #66, owner directive 2026-07-30T17:53Z: "if the bot takes an action it
// should show up as that GH user taking that action." `gh` auth alone does NOT
// deliver that for commits -- it governs the API actor and the push credential,
// while the author inside a commit object comes from git's user.name/user.email
// (the human's, on a developer machine). z-loop/SKILL.md Step 0 therefore
// derives ME_EMAIL from the same `gh api user` call as ME, and the claim row
// stamps both onto the lane worktree.
//
// The subtle part -- and the reason this gets an executable test and not just a
// grep -- is that worktrees SHARE the main repo's .git/config. The obvious
// `git -C <worktree> config user.name` rewrites the HUMAN's identity in their
// own checkout. Only `--worktree` (behind extensions.worktreeConfig) scopes it.
// A future edit dropping that flag would look harmless and silently re-author
// the owner's personal commits, so the behavior is proven against real git.
// ============================================================================
describe("issue #66: lane commits are authored by the account gh is authed as", () => {
  function claimRow(): string {
    const md = skillFile("z-loop/SKILL.md");
    const row = md.split("\n").find((l) => l.includes("| `claim N` |"));
    if (!row) throw new Error("z-loop/SKILL.md's `claim N` action row not found");
    return row;
  }

  test("Step 0 derives ME and ME_EMAIL from one `gh api user` call, storing neither in config.json", () => {
    const md = skillFile("z-loop/SKILL.md");
    expect(md).toMatch(/^ME=\$\(gh api user -q \.login\)$/m);
    expect(md).toMatch(/^ME_ID=\$\(gh api user -q \.id\)$/m);
    expect(md).toMatch(/^ME_EMAIL="\$ME_ID\+\$ME@users\.noreply\.github\.com"$/m);
    // GitHub's noreply form is what links a commit to the account when the
    // account's email is private -- a bare login would not.
    expect(md).toContain("users.noreply.github.com");
    // The whole point of deriving it live: no second copy of the identity can
    // drift from the real auth. Asserted on what actually reaches disk rather
    // than by grepping the source (which legitimately mentions `.login` when
    // describing where identity really comes from): the recorded block carries
    // the CHOICE and nothing that could impersonate an identity.
    const home = makeHome("demo");
    const written = recordIdentityChoice(
      "demo",
      { mode: "bot", tokenLocation: "gh auth login (bot profile)", now: () => "2026-07-30T00:00:00.000Z" },
      home
    );
    expect(Object.keys(written.identity!).sort()).toEqual(["mode", "recordedAt", "tokenLocation"]);
    const onDisk = JSON.stringify(readConfig(home, "demo").identity);
    expect(onDisk).not.toMatch(/users\.noreply\.github\.com/);
    expect(onDisk).not.toMatch(/"(login|email|user)"\s*:/);
  });

  test("the claim row stamps the worktree with --worktree, never the shared-config form", () => {
    const row = claimRow();
    expect(row).toContain('config --worktree user.name "$ME"');
    expect(row).toContain('config --worktree user.email "$ME_EMAIL"');
    // extensions.worktreeConfig must be enabled first or --worktree hard-fails.
    expect(row).toContain("git config extensions.worktreeConfig true");
    // The regression this guards: the same ASSIGNMENT without --worktree,
    // i.e. `config user.name "$ME"`. Matched with its argument so the row's
    // own WARNING prose -- which quotes the bad form by name precisely so a
    // future editor knows not to use it -- isn't mistaken for the bug.
    expect(row).not.toMatch(/config user\.(name|email) "\$/);
  });

  test("EXECUTABLE: the shipped mechanism authors lane commits as the bot and leaves the human's own checkout alone", () => {
    const home = mkdtempSync(join(tmpdir(), "zstack-identity-gitauthor-"));
    homes.push(home);
    const root = toPosixPath(home);
    // Real git, real worktree, the exact three commands from the claim row.
    const script = `
set -e
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
cd "${root}"
git init -q main && cd main
git config user.name "HumanOwner"
git config user.email "human@example.com"
git config commit.gpgsign false
echo a > a.txt && git add . && git commit -qm init
ME="zstack-loop-bot"
ME_EMAIL="4242+zstack-loop-bot@users.noreply.github.com"
git worktree add -q ../wt -b lane HEAD
# --- the claim row's step 4b, verbatim in shape ---
git config extensions.worktreeConfig true
git -C ../wt config --worktree user.name "$ME"
git -C ../wt config --worktree user.email "$ME_EMAIL"
# --- a lane commit, then a commit by the human in their own checkout ---
cd ../wt && echo b > b.txt && git add . && git commit -qm "lane work"
echo "LANE=$(git log -1 --format='%an <%ae>')"
cd ../main && echo c > c.txt && git add . && git commit -qm "human work"
echo "MAIN=$(git log -1 --format='%an <%ae>')"
`;
    const out = runBash(script, { PATH: `${binDir("git")}:${CORE_DIR}` });
    expect(out.stderr).not.toContain("fatal:");
    expect(out.code).toBe(0);
    // The lane's commit is the bot's.
    expect(out.stdout).toContain("LANE=zstack-loop-bot <4242+zstack-loop-bot@users.noreply.github.com>");
    // ...and the human's own checkout is untouched. This is the assertion
    // that fails if --worktree is ever dropped: without it, MAIN becomes the
    // bot too, i.e. the loop silently re-authored the owner's commits.
    expect(out.stdout).toContain("MAIN=HumanOwner <human@example.com>");
  });
});
