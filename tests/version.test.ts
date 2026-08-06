// Gate tests for per-PR version claiming (lib/version.ts). Deterministic and
// free: the pure core is exercised directly, and the CLI edge runs against an
// inline GraphQL executor plus a RECORDING git runner, so the whole claim
// sequence -- what it decides, what it writes, which git commands it issues and
// what it EXITS with -- is proven with no network, no remote, and no repo.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type GraphQLExecutor } from "../lib/board.ts";
import { ZError, type BoardConfig } from "../lib/config.ts";
import { validateConfig } from "../lib/config-schema.ts";
import {
  BUMP_ORDER,
  DEFAULT_BUMP_LABELS,
  FALLBACK_BUMP,
  MAX_ENTRY_CHARS,
  applyClaim,
  assertUsableEntry,
  bumpLevelFor,
  bumpVersion,
  changelogInsert,
  changelogReclaim,
  compareVersions,
  fmtVersion,
  main,
  nextFreeSlot,
  parseVersion,
  planClaim,
  setPackageVersion,
  type GitResult,
  type GitRunner,
  type Version,
} from "../lib/version.ts";

const v = (s: string): Version => parseVersion(s)!;

// -- the version itself -------------------------------------------------------

describe("parseVersion / fmtVersion", () => {
  test("accepts the four-segment shape, trimmed, and round-trips", () => {
    expect(parseVersion("1.0.1.0")).toEqual([1, 0, 1, 0]);
    expect(parseVersion(" 2.10.3.44\n")).toEqual([2, 10, 3, 44]);
    expect(fmtVersion([2, 10, 3, 44])).toBe("2.10.3.44");
  });

  // Three-segment semver is the shape a hand-edit most plausibly leaves behind,
  // and reading it as anything would hand out a slot from a version nobody set.
  test("rejects three-segment semver, extra segments, and non-numerics", () => {
    for (const bad of ["1.0.1", "1.0.1.0.0", "v1.0.1.0", "1.0.1.x", "", "  ", "1.0.-1.0"]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  // Adversarial finding. Claims are parsed from OTHER PRs' branches, so the
  // input is not fully trusted. Past 2^53 `Number` rounds: two different
  // 20-digit segments compare EQUAL and a bump can round back to itself, which
  // breaks the strictly-greater property the whole queue rests on.
  test("rejects segments long enough to lose precision, so 'strictly greater' still holds", () => {
    expect(parseVersion("1.0.0.99999999999999999999")).toBeNull();
    expect(parseVersion("999999999.0.0.0")).toEqual([999999999, 0, 0, 0]); // 9 digits is fine
    expect(parseVersion("1000000000.0.0.0")).toBeNull(); // 10 is not
    // The property the cap protects, at the ceiling.
    const max = parseVersion("999999999.999999999.999999999.999999999")!;
    for (const level of ["major", "minor", "patch", "micro"] as const) {
      expect(compareVersions(bumpVersion(max, level), max)).toBeGreaterThan(0);
    }
  });
});

describe("bumpVersion", () => {
  test("each level resets every segment below it", () => {
    expect(bumpVersion(v("1.2.3.4"), "major")).toEqual([2, 0, 0, 0]);
    expect(bumpVersion(v("1.2.3.4"), "minor")).toEqual([1, 3, 0, 0]);
    expect(bumpVersion(v("1.2.3.4"), "patch")).toEqual([1, 2, 4, 0]);
    expect(bumpVersion(v("1.2.3.4"), "micro")).toEqual([1, 2, 3, 5]);
  });

  test("every bump is strictly greater than its input -- the property the queue rests on", () => {
    for (const level of ["major", "minor", "patch", "micro"] as const) {
      expect(compareVersions(bumpVersion(v("1.2.3.4"), level), v("1.2.3.4"))).toBeGreaterThan(0);
    }
  });
});

describe("compareVersions", () => {
  test("orders lexicographically over the four segments, not numerically over the string", () => {
    // The string comparison every naive version sort gets wrong: "1.10" < "1.9".
    expect(compareVersions(v("1.10.0.0"), v("1.9.0.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0.0"), v("1.0.0.0"))).toBe(0);
    expect(compareVersions(v("1.0.0.9"), v("1.0.1.0"))).toBeLessThan(0);
  });
});

// -- label -> bump level ------------------------------------------------------

describe("bumpLevelFor", () => {
  test("maps the shipped labels and names which one decided", () => {
    expect(bumpLevelFor(["bug"])).toEqual({ level: "patch", from: "bug" });
    expect(bumpLevelFor(["enhancement"])).toEqual({ level: "minor", from: "enhancement" });
    expect(bumpLevelFor(["breaking"])).toEqual({ level: "major", from: "breaking" });
  });

  test("an unmapped or absent label falls to MICRO, naming nothing", () => {
    expect(bumpLevelFor([])).toEqual({ level: "micro" });
    expect(bumpLevelFor(["documentation", "question", "good first issue"])).toEqual({ level: "micro" });
  });

  // Order-independence is the whole reason this is a max rather than a
  // first-match: GitHub returns labels in its own order, and a ticket that is
  // both must not claim a different slot depending on which came back first.
  test("the HIGHEST level wins, whatever order the labels arrive in", () => {
    expect(bumpLevelFor(["bug", "enhancement"]).level).toBe("minor");
    expect(bumpLevelFor(["enhancement", "bug"]).level).toBe("minor");
    expect(bumpLevelFor(["documentation", "breaking", "bug"]).level).toBe("major");
  });

  test("case and surrounding space are ignored on BOTH sides of the lookup", () => {
    expect(bumpLevelFor([" Bug "]).level).toBe("patch");
    expect(bumpLevelFor(["breaking"], { Breaking: "major" }).level).toBe("major");
    expect(bumpLevelFor(["BREAKING"], { breaking: "major" }).level).toBe("major");
  });

  // A custom map REPLACES the defaults rather than layering over them, so a
  // project can demote a default label it uses to mean something else.
  test("a custom map replaces the defaults, so a default label can be demoted", () => {
    expect(bumpLevelFor(["enhancement"], { chore: "patch" }).level).toBe("micro");
    expect(bumpLevelFor(["bug"], {}).level).toBe("micro");
  });
});

// -- slot allocation ----------------------------------------------------------

describe("nextFreeSlot", () => {
  test("with an empty queue it bumps the base", () => {
    const pick = nextFreeSlot(v("1.0.1.0"), [], "patch");
    expect(fmtVersion(pick.version)).toBe("1.0.2.0");
    expect(fmtVersion(pick.ceiling)).toBe("1.0.1.0");
    expect(pick.ceilingFrom).toBeUndefined();
  });

  // The regression this design exists to prevent: bumping the BASE alone hands
  // out 1.0.2.0 while PR #7 already holds 1.1.0.0, and whichever lands last
  // makes the version on main go backwards.
  test("an outstanding claim above the base becomes the ceiling, so the pick never regresses", () => {
    const claimed = [{ pr: 7, branch: "z/ticket-7-x", version: "1.1.0.0" }];
    const pick = nextFreeSlot(v("1.0.1.0"), claimed, "patch");
    expect(fmtVersion(pick.version)).toBe("1.1.1.0");
    expect(pick.ceilingFrom).toEqual(claimed[0]);
  });

  test("the pick is strictly above the base AND every claim, at every level", () => {
    const claimed = [
      { pr: 1, branch: "a", version: "1.0.1.1" },
      { pr: 2, branch: "b", version: "1.2.0.0" },
      { pr: 3, branch: "c", version: "1.0.9.9" },
    ];
    for (const level of ["major", "minor", "patch", "micro"] as const) {
      const pick = nextFreeSlot(v("1.0.1.0"), claimed, level);
      expect(compareVersions(pick.version, v("1.0.1.0"))).toBeGreaterThan(0);
      for (const c of claimed) expect(compareVersions(pick.version, v(c.version))).toBeGreaterThan(0);
    }
  });

  // An unreadable claim must not drag the ceiling DOWN to the base: read as
  // 0.0.0.0 it would lose to the base anyway, but read as a real claim it would
  // corrupt the max. Skipping is the only reading that is safe in both
  // directions.
  test("an unparseable claim is skipped, not read as 0.0.0.0", () => {
    const pick = nextFreeSlot(v("1.0.1.0"), [
      { pr: 4, branch: "old", version: "" },
      { pr: 5, branch: "semver", version: "2.0.0" },
      { pr: 6, branch: "real", version: "1.0.3.0" },
    ], "micro");
    expect(fmtVersion(pick.version)).toBe("1.0.3.1");
    expect(pick.ceilingFrom?.pr).toBe(6);
  });

  test("a claim BELOW the base leaves the base as the ceiling", () => {
    const pick = nextFreeSlot(v("1.5.0.0"), [{ pr: 9, branch: "stale", version: "1.0.0.0" }], "micro");
    expect(fmtVersion(pick.version)).toBe("1.5.0.1");
    expect(pick.ceilingFrom).toBeUndefined();
  });
});

// -- CHANGELOG ----------------------------------------------------------------

const CL_PLAIN = `# Changelog

Preamble line.

## [1.0.1.0] - 2026-08-02

### Added

- the old thing
`;

const CL_UNRELEASED = `# Changelog

Preamble line.

## [Unreleased]

### Added

- work that never got a version

## [1.0.1.0] - 2026-08-02

### Added

- the old thing
`;

describe("changelogInsert", () => {
  test("inserts the new section above the newest version, preamble untouched", () => {
    const out = changelogInsert(CL_PLAIN, "1.0.2.0", "2026-08-06", "patch", "- fixed a thing (#42)");
    expect(out.startsWith("# Changelog\n\nPreamble line.\n\n## [1.0.2.0] - 2026-08-06")).toBe(true);
    expect(out).toContain("### Fixed\n\n- fixed a thing (#42)");
    expect(out).toContain("## [1.0.1.0] - 2026-08-02"); // the old section survives, below
    expect(out.indexOf("[1.0.2.0]")).toBeLessThan(out.indexOf("[1.0.1.0]"));
  });

  // The one-time transition off the manual release PR: whatever accumulated
  // under [Unreleased] rolls into the version that is actually shipping instead
  // of waiting for a human, and the heading is GONE afterwards.
  test("[Unreleased] is rewritten into this version, absorbing what accumulated under it", () => {
    const out = changelogInsert(CL_UNRELEASED, "1.0.2.0", "2026-08-06", "patch", "- fixed a thing (#42)");
    expect(out).not.toContain("[Unreleased]");
    expect(out).toContain("## [1.0.2.0] - 2026-08-06");
    expect(out).toContain("- fixed a thing (#42)");
    expect(out).toContain("- work that never got a version"); // absorbed, not dropped
    expect(out).toContain("## [1.0.1.0] - 2026-08-02");
    // Exactly one version list, still newest-first.
    expect(out.indexOf("[1.0.2.0]")).toBeLessThan(out.indexOf("[1.0.1.0]"));
  });

  test("a file with no version list at all gets the section appended, not guessed into place", () => {
    const out = changelogInsert("# Changelog\n\nNothing yet.\n", "1.0.0.1", "2026-08-06", "micro", "- first (#1)");
    expect(out).toBe("# Changelog\n\nNothing yet.\n\n## [1.0.0.1] - 2026-08-06\n\n### Changed\n\n- first (#1)\n");
  });

  test("the section heading follows the bump level", () => {
    const section = (level: "major" | "minor" | "patch" | "micro") =>
      changelogInsert(CL_PLAIN, "9.9.9.9", "2026-08-06", level, "- x").match(/### (\w+)/)![1];
    expect(section("minor")).toBe("Added");
    expect(section("patch")).toBe("Fixed");
    expect(section("major")).toBe("Changed");
    expect(section("micro")).toBe("Changed");
  });
});

describe("changelogReclaim", () => {
  test("re-points the heading only, leaving this ticket's prose alone", () => {
    const claimed = changelogInsert(CL_PLAIN, "1.0.2.0", "2026-08-06", "patch", "- fixed a thing (#42)");
    const out = changelogReclaim(claimed, "1.0.2.0", "1.0.3.0", "2026-08-07");
    expect(out).toContain("## [1.0.3.0] - 2026-08-07");
    expect(out).not.toContain("[1.0.2.0]");
    expect(out).toContain("- fixed a thing (#42)");
    expect(out).toContain("## [1.0.1.0] - 2026-08-02"); // untouched
  });

  // Inserting a second section would leave the stale heading behind and the
  // CHANGELOG would claim the work shipped twice.
  test("throws rather than adding a second section when the old heading is missing", () => {
    expect(() => changelogReclaim(CL_PLAIN, "1.0.2.0", "1.0.3.0", "2026-08-07")).toThrow(ZError);
    expect(() => changelogReclaim(CL_PLAIN, "1.0.2.0", "1.0.3.0", "2026-08-07")).toThrow(/no "## \[1\.0\.2\.0\]" heading/);
  });

  test("the version's dots are escaped, so 1.0.2.0 never matches 1x0x2x0", () => {
    const weird = "# C\n\n## [1x0x2x0] - 2026-08-06\n\n- x\n";
    expect(() => changelogReclaim(weird, "1.0.2.0", "1.0.3.0", "2026-08-07")).toThrow(ZError);
  });
});

// -- the entry is the one untrusted input -------------------------------------

// Review finding, LLM Output Trust Boundary. The entry is written by the merge
// agent and lands verbatim in a file that changelogInsert and changelogReclaim
// both parse by regex, so a `## [` line inside the prose is a structural forgery
// rather than a typo.
describe("assertUsableEntry", () => {
  test("ordinary prose and Keep-a-Changelog sub-headings pass", () => {
    expect(() => assertUsableEntry("- Fixed the parser (#42).")).not.toThrow();
    expect(() => assertUsableEntry("### Fixed\n\n- a thing\n\n#### detail")).not.toThrow();
    // `## [` only matters at the START of a line -- prose may discuss one.
    expect(() => assertUsableEntry("- The heading `## [1.0.0.0]` is written by the CLI.")).not.toThrow();
  });

  test("an entry carrying its own version heading is REFUSED, and the message names the line", () => {
    expect(() => assertUsableEntry("- did a thing\n\n## [9.9.9.9] - 2020-01-01\n\n- forged")).toThrow(ZError);
    expect(() => assertUsableEntry("## [Unreleased]\n\n- x")).toThrow(/contains its own version heading/);
    expect(() => assertUsableEntry("- x\n## [1.0.2.0] - 2026-01-01")).toThrow(/"## \[1\.0\.2\.0\] - 2026-01-01"/);
  });

  test("empty and over-ceiling entries are refused", () => {
    expect(() => assertUsableEntry("   \n\t ")).toThrow(/empty/);
    expect(() => assertUsableEntry("x".repeat(MAX_ENTRY_CHARS + 1))).toThrow(/over the 20000 ceiling/);
    expect(() => assertUsableEntry("x".repeat(MAX_ENTRY_CHARS))).not.toThrow(); // the ceiling itself is legal
  });

  // The concrete damage: a forged heading placed above the real one would be the
  // first `## [` match, and changelogReclaim replaces the FIRST match.
  test("the forgery it prevents would have re-pointed the wrong heading", () => {
    const forged = "## [1.0.2.0] - 2020-01-01\n\n- prose pretending to be a release";
    expect(() => assertUsableEntry(forged)).toThrow(ZError);
    // Proof the guard is load-bearing: fed through unchecked, the entry's line
    // becomes a heading indistinguishable from a real one.
    const corrupted = changelogInsert(CL_PLAIN, "1.0.3.0", "2026-08-06", "patch", forged);
    expect(corrupted.match(/^## \[1\.0\.2\.0\]/m)).not.toBeNull();
  });
});

// -- package.json -------------------------------------------------------------

describe("setPackageVersion", () => {
  test("replaces the top-level version and reflows nothing else", () => {
    const before = '{\n  "name": "zstack",\n  "version": "1.0.1.0",\n  "private": true\n}\n';
    expect(setPackageVersion(before, "1.0.2.0")).toBe(
      '{\n  "name": "zstack",\n  "version": "1.0.2.0",\n  "private": true\n}\n'
    );
  });

  test("a package.json with no version field is returned untouched", () => {
    const before = '{\n  "name": "zstack"\n}\n';
    expect(setPackageVersion(before, "1.0.2.0")).toBe(before);
  });

  // A dependency pinned to the same string as the package's own version is the
  // shape that would make a blind first-match replacement hit the wrong line.
  test("a dependency pinned to the same string is not the one rewritten", () => {
    const before = '{\n  "version": "1.0.1.0",\n  "dependencies": { "dep": "1.0.1.0" }\n}\n';
    const after = setPackageVersion(before, "1.0.2.0");
    expect(after).toContain('"version": "1.0.2.0"');
    expect(after).toContain('"dep": "1.0.1.0"');
  });

  test("invalid JSON is a loud ZError, never a silently unbumped file", () => {
    expect(() => setPackageVersion("{ not json", "1.0.2.0")).toThrow(ZError);
  });

  // Adversarial finding, reproduced before the fix. "the first textual match is
  // the top-level key" is FALSE when a nested object carries the same version
  // string earlier in the file: the dependency was rewritten and the package's
  // own version left stale, silently, with the file still valid JSON. The test
  // above only passed because it happened to order the keys favourably.
  test("a nested version key EARLIER in the file cannot be mistaken for the top-level one", () => {
    const before = '{\n  "dependency": { "version": "1.0.0.0" },\n  "version": "1.0.0.0"\n}\n';
    expect(() => setPackageVersion(before, "2.0.0.0")).toThrow(/Could not set package\.json's top-level "version"/);
  });

  test("the post-edit re-parse proves the top-level field actually moved", () => {
    const before = '{\n  "name": "x",\n  "version": "1.0.1.0"\n}\n';
    expect(JSON.parse(setPackageVersion(before, "1.0.2.0")).version).toBe("1.0.2.0");
  });
});

// -- the decision -------------------------------------------------------------

describe("planClaim", () => {
  const base = v("1.0.1.0");

  test("an untouched branch claims the next slot", () => {
    const p = planClaim({ base, branch: base, fork: base, claimed: [], labels: ["bug"] });
    expect(p.action).toBe("claim");
    expect(p.version).toBe("1.0.2.0");
    expect(p.level).toBe("patch");
    expect(p.levelFrom).toBe("bug");
    expect(p.reclaimFrom).toBeUndefined();
  });

  // Re-running on an unchanged queue must be a NO-OP, not a ratchet: the merge
  // prompt tells the agent to re-run the claim after a conflict resolution, and
  // a command that bumped every time would inflate the version once per retry.
  test("re-running with the queue unmoved KEEPS the existing claim", () => {
    const p = planClaim({ base, branch: v("1.0.2.0"), fork: base, claimed: [], labels: ["bug"] });
    expect(p.action).toBe("keep");
    expect(p.version).toBe("1.0.2.0");
  });

  test("the queue moving ABOVE this branch's claim re-points it", () => {
    const p = planClaim({
      base,
      branch: v("1.0.2.0"),
      fork: base,
      claimed: [{ pr: 7, branch: "other", version: "1.0.5.0" }],
      labels: ["bug"],
    });
    expect(p.action).toBe("reclaim");
    expect(p.reclaimFrom).toBe("1.0.2.0");
    expect(p.version).toBe("1.0.6.0");
    expect(p.ceilingFrom?.pr).toBe(7);
  });

  // A claim that is still the highest thing around is left alone even when the
  // queue changed underneath it -- an outstanding PR closing must not force a
  // pointless rewrite of a branch that is already correct.
  test("a claim still above the queue is kept, not lowered", () => {
    const p = planClaim({
      base,
      branch: v("2.0.0.0"),
      fork: base,
      claimed: [{ pr: 7, branch: "other", version: "1.0.5.0" }],
      labels: ["bug"],
    });
    expect(p.action).toBe("keep");
    expect(p.version).toBe("2.0.0.0");
  });

  test("the custom label map from config decides the level", () => {
    const p = planClaim({ base, branch: base, fork: base, claimed: [], labels: ["chore"], bumpLabels: { chore: "minor" } });
    expect(p.level).toBe("minor");
    expect(p.version).toBe("1.1.0.0");
  });

  // THE defect `fork` exists to close. Merges are serialized, so origin/<base>
  // moves under every lane during a drain: a branch cut at 1.0.1.0 while another
  // lane merged 1.0.2.0 has branch !== base while having claimed NOTHING.
  // Reading that as a re-claim sent changelogReclaim looking for a
  // "## [1.0.1.0]" heading -- which exists, as a historical release -- and
  // rewrote it.
  test("a branch left behind by a moving base is a FRESH claim, not a re-claim of a historical release", () => {
    const p = planClaim({
      base: v("1.0.2.0"), // another lane merged during this drain
      branch: v("1.0.1.0"), // untouched; still what the branch was cut with
      fork: v("1.0.1.0"),
      claimed: [],
      labels: ["bug"],
    });
    expect(p.action).toBe("claim");
    expect(p.reclaimFrom).toBeUndefined();
    expect(p.version).toBe("1.0.3.0"); // above the MOVED base, not the fork
  });

  // The mirror: a branch that really did claim, then watched the base move PAST
  // its claim. branch < base here too, so a base comparison would call it fresh
  // and insert a second section, orphaning the first.
  test("a real claim overtaken by the base is still a RE-claim, not a second section", () => {
    const p = planClaim({
      base: v("1.0.5.0"),
      branch: v("1.0.2.0"), // this branch's own claim, now below the base
      fork: v("1.0.1.0"),
      claimed: [],
      labels: ["bug"],
    });
    expect(p.action).toBe("reclaim");
    expect(p.reclaimFrom).toBe("1.0.2.0");
    expect(p.version).toBe("1.0.6.0");
  });
});

// -- writing ------------------------------------------------------------------

describe("applyClaim", () => {
  const dirs: string[] = [];
  const scratch = (files: Record<string, string>): string => {
    const d = mkdtempSync(join(tmpdir(), "zstack-version-"));
    dirs.push(d);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body, "utf8");
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("writes all three files and reports exactly what it touched", () => {
    const d = scratch({
      VERSION: "1.0.1.0\n",
      "package.json": '{\n  "name": "x",\n  "version": "1.0.1.0"\n}\n',
      "CHANGELOG.md": CL_PLAIN,
    });
    const touched = applyClaim({
      worktree: d,
      versionPath: "VERSION",
      next: "1.0.2.0",
      level: "patch",
      date: "2026-08-06",
      entry: "- fixed a thing (#42)",
    });
    expect(touched).toEqual(["VERSION", "package.json", "CHANGELOG.md"]);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.2.0\n");
    expect(readFileSync(join(d, "package.json"), "utf8")).toContain('"version": "1.0.2.0"');
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toContain("## [1.0.2.0] - 2026-08-06");
  });

  // The pack installs into other people's repos: a project with neither
  // package.json nor CHANGELOG.md must still get a valid claim rather than a
  // crash on a file it never had.
  test("package.json and CHANGELOG.md are optional -- VERSION alone is a valid claim", () => {
    const d = scratch({ VERSION: "1.0.1.0\n" });
    const touched = applyClaim({
      worktree: d,
      versionPath: "VERSION",
      next: "1.0.2.0",
      level: "patch",
      date: "2026-08-06",
      entry: "- x",
    });
    expect(touched).toEqual(["VERSION"]);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.2.0\n");
  });

  test("reclaimFrom re-points the heading instead of inserting a second section", () => {
    const d = scratch({
      VERSION: "1.0.2.0\n",
      "CHANGELOG.md": changelogInsert(CL_PLAIN, "1.0.2.0", "2026-08-06", "patch", "- fixed a thing (#42)"),
    });
    applyClaim({
      worktree: d,
      versionPath: "VERSION",
      next: "1.0.6.0",
      level: "patch",
      date: "2026-08-07",
      entry: "- fixed a thing (#42)",
      reclaimFrom: "1.0.2.0",
    });
    const cl = readFileSync(join(d, "CHANGELOG.md"), "utf8");
    expect(cl).toContain("## [1.0.6.0] - 2026-08-07");
    expect(cl).not.toContain("[1.0.2.0]");
    expect(cl.match(/- fixed a thing \(#42\)/g)!.length).toBe(1);
  });
});

// -- the CLI edge -------------------------------------------------------------

const CFG: BoardConfig = {
  slug: "zstack",
  owner: "zacgoodwin",
  repo: "zstack",
  projectNumber: 1,
  projectId: "PVT_1",
  repositoryId: "R_1",
  statusField: { id: "F_s", dataType: "SINGLE_SELECT", options: { Todo: "o1" } },
  fields: {},
};

// Enough of ItemLookup's real shape for toItem to parse; labels are what the
// claim actually reads off it.
const RATE_LIMIT = { remaining: 5000, resetAt: "2030-01-01T00:00:00Z" };

function itemLookup(labels: string[]) {
  return {
    rateLimit: RATE_LIMIT,
    repository: {
      issue: {
        number: 42,
        title: "Fix the parser",
        url: "https://example.invalid/42",
        body: "body",
        milestone: null,
        labels: { pageInfo: { hasNextPage: false }, nodes: labels.map((name) => ({ name })) },
        projectItems: {
          pageInfo: { hasNextPage: false },
          nodes: [{ project: { number: 1 }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] } }],
        },
      },
    },
  };
}

function openPrs(prs: { number: number; branch: string; version: string | null }[]) {
  return {
    rateLimit: RATE_LIMIT,
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: prs.map((p) => ({
          number: p.number,
          url: `https://example.invalid/pr/${p.number}`,
          headRefName: p.branch,
          headRef: p.version === null ? { target: {} } : { target: { file: { object: { text: `${p.version}\n` } } } },
        })),
      },
    },
  };
}

function executor(labels: string[], prs: { number: number; branch: string; version: string | null }[]): GraphQLExecutor {
  return async (query) => {
    if (query.includes("query ItemLookup")) return itemLookup(labels) as any;
    if (query.includes("query OpenPrVersions")) return openPrs(prs) as any;
    if (query.includes("query RateLimit")) return { rateLimit: RATE_LIMIT };
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  };
}

// Answers the reads the CLI makes and records every command, so a test can
// assert the exact git sequence rather than a side effect of it.
//
// `forkVersion` defaults to `baseVersion`: the ordinary case is a branch cut
// from the current base. Passing them apart is how a test models the base moving
// under a lane mid-drain, which is the case `fork` exists for.
const FORK_SHA = "abc1234";

function recordingGit(
  worktree: string,
  opts: {
    branch?: string;
    baseVersion?: string;
    forkVersion?: string;
    fail?: string;
    // What `rev-parse --show-toplevel` answers. Set it to something OTHER than
    // the worktree to model git ascending out of a non-worktree directory.
    toplevel?: string;
    headVersion?: string; // VERSION at HEAD (committed), vs. forkVersion (inherited)
    dirty?: string;       // `git status --porcelain` output for the owned files
    unpushed?: string;    // `rev-list --count origin/<branch>..HEAD`
    // Emit a stderr line on every SUCCESSFUL read, which is what git really does
    // (CRLF advice, detached-HEAD hints) while still exiting 0. Folding stderr
    // into the value appends that text to a sha, and the next
    // `show <sha>:VERSION` then looks up a ref that does not exist.
    noisy?: boolean;
  } = {}
) {
  const calls: string[][] = [];
  const value = (joined: string): string => {
    // Answers with the worktree it was given, i.e. a real working-tree root.
    // `opts.toplevel` models git ASCENDING out of a non-worktree directory.
    if (joined.includes("rev-parse --show-toplevel")) return opts.toplevel ?? worktree;
    if (joined.includes("rev-parse --abbrev-ref HEAD")) return opts.branch ?? "z/ticket-42-fix-the-parser";
    if (joined.includes("merge-base")) return FORK_SHA;
    if (joined.includes(`show ${FORK_SHA}:`)) return opts.forkVersion ?? opts.baseVersion ?? "1.0.1.0";
    if (joined.includes("show origin/")) return opts.baseVersion ?? "1.0.1.0";
    // The COMMITTED version -- what decides "has this branch already claimed?".
    // Defaults to the fork (an unclaimed branch); `opts.headVersion` models a
    // branch that really did commit a claim.
    if (joined.includes("show HEAD:")) return opts.headVersion ?? opts.forkVersion ?? opts.baseVersion ?? "1.0.1.0";
    // Clean tree by default; `opts.dirty` models a previous attempt that wrote
    // the files and then failed to commit them.
    if (joined.includes("status --porcelain")) return opts.dirty ?? "";
    // 0 = the remote already has HEAD. `opts.unpushed` models a commit that
    // never reached origin.
    if (joined.includes("rev-list --count")) return opts.unpushed ?? "0";
    return "";
  };
  const run: GitRunner = (args): GitResult => {
    calls.push(args);
    const joined = args.join(" ");
    if (opts.fail && joined.includes(opts.fail)) return { code: 1, out: "", err: `boom: ${opts.fail}` };
    return opts.noisy
      ? { code: 0, out: value(joined), err: "warning: LF will be replaced by CRLF" }
      : { code: 0, out: value(joined) };
  };
  return { calls, run, worktree };
}

describe("the claim CLI", () => {
  const dirs: string[] = [];
  const logs: string[] = [];
  const errs: string[] = [];
  let restore: (() => void) | undefined;

  function scratchRepo(version = "1.0.1.0"): string {
    const d = mkdtempSync(join(tmpdir(), "zstack-claim-"));
    dirs.push(d);
    writeFileSync(join(d, "VERSION"), `${version}\n`, "utf8");
    writeFileSync(join(d, "package.json"), `{\n  "name": "x",\n  "version": "${version}"\n}\n`, "utf8");
    writeFileSync(join(d, "CHANGELOG.md"), CL_PLAIN, "utf8");
    return d;
  }

  function capture(): void {
    const log = console.log;
    const err = console.error;
    console.log = (...a: any[]) => void logs.push(a.join(" "));
    console.error = (...a: any[]) => void errs.push(a.join(" "));
    restore = () => {
      console.log = log;
      console.error = err;
    };
  }

  afterEach(() => {
    restore?.();
    restore = undefined;
    logs.length = 0;
    errs.length = 0;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const run = (argv: string[], exec: GraphQLExecutor, git: GitRunner, cfg: BoardConfig = CFG) =>
    main(argv, () => new Board(cfg, exec), () => cfg, git);

  test("a clean claim writes the three files, commits, pushes, and prints the decision", async () => {
    const d = scratchRepo();
    const g = recordingGit(d);
    const titleOut = join(d, "..", `title-${process.pid}.txt`);
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--title", "Fix the parser",
       "--title-out", titleOut, "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(code).toBe(0);

    const out = JSON.parse(logs.join("\n"));
    expect(out.action).toBe("claim");
    expect(out.version).toBe("1.0.2.0"); // 1.0.1.0 base + patch (label `bug`)
    expect(out.level).toBe("patch");
    expect(out.prTitle).toBe("v1.0.2.0 Fix the parser");
    expect(out.touched).toEqual(["VERSION", "package.json", "CHANGELOG.md"]);

    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.2.0\n");
    expect(readFileSync(join(d, "package.json"), "utf8")).toContain('"version": "1.0.2.0"');
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toContain("## [1.0.2.0] - 2026-08-06");
    expect(readFileSync(titleOut, "utf8")).toBe("v1.0.2.0 Fix the parser");
    rmSync(titleOut, { force: true });

    const cmds = g.calls.map((c) => c.join(" "));
    // Fetch before any VERSION is read: a claim computed off a stale base picks
    // a slot already on main. (The working-tree guard is the only call ahead of
    // it -- see the ordering test below.)
    const fetchAt = cmds.findIndex((c) => c.includes("fetch origin main"));
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(cmds.findIndex((c) => c.includes("show origin/main:")));
    expect(cmds.some((c) => c.includes("add -- VERSION package.json CHANGELOG.md"))).toBe(true);
    expect(cmds.some((c) => c.includes("commit -m chore: claim v1.0.2.0 for #42"))).toBe(true);
    expect(cmds.some((c) => c.includes("push origin HEAD"))).toBe(true);
    // Staged paths are exactly what was written -- never `add -A`, which would
    // sweep a stray file in the worktree into the merge commit.
    expect(cmds.some((c) => c.includes("add -A") || c.includes("add ."))).toBe(false);
  });

  test("the entry file is the ONLY latent input, and it lands in the CHANGELOG verbatim", async () => {
    const d = scratchRepo();
    const entry = join(d, "..", `entry-${process.pid}.md`);
    writeFileSync(entry, "- The parser no longer drops a trailing comma (#42).\n", "utf8");
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--entry-file", entry, "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(0);
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toContain(
      "- The parser no longer drops a trailing comma (#42)."
    );
    rmSync(entry, { force: true });
  });

  test("with NO --entry-file the ticket title is the entry, never an empty section", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(0);
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toContain("- Fix the parser (#42)");
  });

  // Adversarial finding. An --entry-file that was NAMED but is absent is a
  // broken artifact path, not an omitted option: the caller believed it wrote
  // prose there, and falling back silently commits the ticket title while the
  // real entry is lost. An unattended caller cannot tell the two apart. The
  // previous version of this test asserted the silent fallback -- it encoded
  // the defect rather than catching it.
  test("a NAMED but missing --entry-file is refused, not silently replaced by the title", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main",
       "--entry-file", join(d, "..", "does-not-exist.md"), "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/does not exist\. Write the CHANGELOG entry there first/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
  });

  test("--dry-run decides and prints but writes and commits NOTHING", async () => {
    const d = scratchRepo();
    const g = recordingGit(d);
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--dry-run", "--date", "2026-08-06"],
      executor(["enhancement"], []),
      g.run
    );
    restore!();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n")).version).toBe("1.1.0.0"); // enhancement -> minor
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toBe(CL_PLAIN);
    const cmds = g.calls.map((c) => c.join(" "));
    expect(cmds.some((c) => c.includes("commit") || c.includes("push"))).toBe(false);
  });

  test("the queue is read from open PRs, and this branch's own PR is not competition", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--dry-run", "--date", "2026-08-06"],
      executor(["bug"], [
        { number: 7, branch: "z/ticket-7-other", version: "1.4.0.0" },
        // This branch's own already-open PR: counting it would make every
        // re-run leapfrog its own claim.
        { number: 8, branch: "z/ticket-42-fix-the-parser", version: "9.9.9.9" },
        // No VERSION at that head: claims nothing, must not crash the read.
        { number: 9, branch: "z/ticket-9-old", version: null },
      ]),
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(0);
    const out = JSON.parse(logs.join("\n"));
    expect(out.version).toBe("1.4.1.0"); // ceiling 1.4.0.0 (PR #7) + patch
    // #8 is this branch's own PR, and #9's head has no readable VERSION -- so
    // neither reaches the queue at all, by two different routes.
    expect(out.claimed.map((c: any) => c.pr)).toEqual([7]);
  });

  test("an unmoved queue on a re-run is a KEEP: no second commit, no version inflation", async () => {
    const d = scratchRepo("1.0.2.0"); // already claimed AND committed
    const g = recordingGit(d, { headVersion: "1.0.2.0" });
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n")).action).toBe("keep");
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.2.0\n");
    expect(g.calls.map((c) => c.join(" ")).some((c) => c.includes("commit"))).toBe(false);
  });

  test("a moved queue on a re-run re-points the claim in place", async () => {
    const d = scratchRepo("1.0.2.0");
    writeFileSync(
      join(d, "CHANGELOG.md"),
      changelogInsert(CL_PLAIN, "1.0.2.0", "2026-08-06", "patch", "- fixed a thing (#42)"),
      "utf8"
    );
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-07"],
      executor(["bug"], [{ number: 7, branch: "other", version: "1.0.5.0" }]),
      recordingGit(d, { headVersion: "1.0.2.0" }).run
    );
    restore!();
    expect(code).toBe(0);
    const out = JSON.parse(logs.join("\n"));
    expect(out.action).toBe("reclaim");
    expect(out.version).toBe("1.0.6.0");
    const cl = readFileSync(join(d, "CHANGELOG.md"), "utf8");
    expect(cl).toContain("## [1.0.6.0] - 2026-08-07");
    expect(cl.match(/- fixed a thing \(#42\)/g)!.length).toBe(1); // re-pointed, not duplicated
  });

  // End to end through the CLI: another lane merged 1.0.2.0 during this drain,
  // so origin/main moved while this branch sat untouched at 1.0.1.0. Read
  // against the BASE that is a re-claim, and changelogReclaim rewrites the
  // historical "## [1.0.1.0]" release heading. Read against the FORK it is what
  // it is -- a fresh claim above the moved base.
  test("a base that moved under an untouched branch does not rewrite a historical release heading", async () => {
    const d = scratchRepo("1.0.1.0");
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d, { baseVersion: "1.0.2.0", forkVersion: "1.0.1.0" }).run
    );
    restore!();
    expect(code).toBe(0);
    const out = JSON.parse(logs.join("\n"));
    expect(out.action).toBe("claim");
    expect(out.version).toBe("1.0.3.0"); // above the MOVED base
    const cl = readFileSync(join(d, "CHANGELOG.md"), "utf8");
    expect(cl).toContain("## [1.0.3.0] - 2026-08-06");
    expect(cl).toContain("## [1.0.1.0] - 2026-08-02"); // the old release, untouched
  });

  // git writes advice to stderr and still exits 0. The value read off each
  // command is parsed -- a sha handed straight back to `git show`, a branch name,
  // a version -- so folding stderr in corrupts it. Same run as the clean claim
  // above, with every read noisy: identical result, or the runner is wrong.
  test("git advice on stderr does not corrupt a value read off stdout", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d, { noisy: true }).run
    );
    restore!();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n")).version).toBe("1.0.2.0");
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.2.0\n");
  });

  // Every failure below must leave the branch UNCLAIMED and exit nonzero: the
  // merge prompt maps that to BLOCKED, and a merge that proceeds on a guessed
  // slot is the failure per-PR claiming exists to remove.
  test("a ticket that is not on the board fails closed", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      async (q) => {
        if (q.includes("query ItemLookup")) return { rateLimit: RATE_LIMIT, repository: { issue: null } } as any;
        if (q.includes("query RateLimit")) return { rateLimit: RATE_LIMIT };
        throw new Error("unexpected");
      },
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/not on the board/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
  });

  test("an unreadable version queue fails closed rather than claiming base+1", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      async (q) => {
        if (q.includes("query ItemLookup")) return itemLookup(["bug"]) as any;
        if (q.includes("query OpenPrVersions")) return { rateLimit: RATE_LIMIT, repository: null } as any;
        if (q.includes("query RateLimit")) return { rateLimit: RATE_LIMIT };
        throw new Error("unexpected");
      },
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/came back null/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
  });

  // The other three VERSION reads have the same contract as the base read below
  // and each was its own untested arm. They matter individually because they
  // fail at different points: the fork read decides claim-vs-reclaim, and the
  // branch read is the value every comparison is made against. A silent default
  // on any of them hands out a slot computed from a number nobody set.
  test("an unparseable VERSION at the merge base is a loud refusal, not a fresh claim", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { forkVersion: "not-a-version" }).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/at the merge base .* not a MAJOR\.MINOR\.PATCH\.MICRO version/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
  });

  test("an unparseable VERSION at HEAD is a loud refusal", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { headVersion: "1.0.1" }).run // three-segment semver
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/at HEAD is "1\.0\.1", not a MAJOR\.MINOR\.PATCH\.MICRO version/);
  });

  // Prior learning `git-c-ascends-out-of-non-repo-dirs` (10/10, this repo):
  // `git -C <dir>` ASCENDS out of a directory that is not a working tree and
  // answers for the ENCLOSING repo, exiting 0. An empty leftover
  // `.worktrees/ticket-<N>` -- what reconcile's force-remove leaves behind -- is
  // the observed shape, and existsSync cannot see it because the directory IS
  // there. Unguarded, the claim is computed on the main checkout's branch, base
  // and merge-base, then committed to the main checkout.
  test("a directory that is not a working tree root is refused, not silently answered for by the enclosing repo", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d, { toplevel: join(tmpdir(), "some-enclosing-repo") }).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/is not the root of a git working tree/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
  });

  // The guard must run BEFORE every read whose answer it invalidates -- a check
  // placed after the fetch/branch/base reads would be documentation, not a gate.
  test("the working-tree check is the FIRST git call, ahead of every read it protects", async () => {
    const d = scratchRepo();
    const g = recordingGit(d);
    capture();
    await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(g.calls[0].join(" ")).toContain("rev-parse --show-toplevel");
  });

  test("a VERSION that is not in the commit at all is named, not created from thin air", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { fail: "show HEAD:" }).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/reading VERSION at HEAD failed/);
  });

  // Adversarial finding, and the worst one it found. A previous attempt that
  // wrote the files and then failed to COMMIT them used to be read as "already
  // claimed" on the retry -- because the branch version came off DISK. The retry
  // resolved to `keep` and exited 0 having committed nothing, so the PR was
  // opened from a branch whose HEAD still carried the old version: exactly the
  // vacuous state per-PR claiming exists to remove. HEAD is the source of truth
  // now, and a dirty owned file is refused rather than written over.
  test("a half-finished previous attempt is refused, never read as an existing claim", async () => {
    const d = scratchRepo();
    const g = recordingGit(d, { dirty: " M VERSION\n M CHANGELOG.md" });
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/uncommitted changes/);
    expect(errs.join("\n")).toMatch(/git -C .* checkout --/); // the message says how to clear it
    expect(g.calls.map((c) => c.join(" ")).some((c) => c.includes("commit"))).toBe(false);
  });

  // The other half of the same finding: the commit landed but the push failed.
  // `keep` is a VERIFICATION, not a no-op -- a claim the remote does not have is
  // not a claim, because the PR is opened from the remote branch.
  test("a claim that was committed but never pushed is re-pushed on the keep path", async () => {
    const d = scratchRepo("1.0.2.0");
    const g = recordingGit(d, { headVersion: "1.0.2.0", unpushed: "1" });
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(code).toBe(0);
    const out = JSON.parse(logs.join("\n"));
    expect(out.action).toBe("keep");
    expect(out.repushed).toBe(true);
    expect(g.calls.map((c) => c.join(" ")).some((c) => c.includes("push origin HEAD"))).toBe(true);
  });

  test("a keep whose commit is already on the remote pushes nothing", async () => {
    const d = scratchRepo("1.0.2.0");
    const g = recordingGit(d, { headVersion: "1.0.2.0", unpushed: "0" });
    capture();
    await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(JSON.parse(logs.join("\n")).repushed).toBe(false);
    expect(g.calls.map((c) => c.join(" ")).some((c) => c.includes("push"))).toBe(false);
  });

  // Adversarial finding. A valid worktree is not necessarily THIS ticket's, and
  // the next step commits. Same lesson #248 learned about the merge gate.
  test("another lane's worktree, and the base checkout itself, are both refused", async () => {
    const d = scratchRepo();
    capture();
    const other = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { branch: "z/ticket-77-something-else" }).run
    );
    const onBase = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { branch: "main" }).run
    );
    restore!();
    expect(other).toBe(1);
    expect(onBase).toBe(1);
    expect(errs.join("\n")).toMatch(/another ticket's lane branch, not #42's/);
    expect(errs.join("\n")).toMatch(/is on main itself/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
  });

  // ...but an ordinary human feature branch still works: the bind is narrow on
  // purpose, so running this by hand outside the loop is not collateral damage.
  test("an ordinary feature branch is not refused by the lane bind", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--dry-run"],
      executor(["bug"], []),
      recordingGit(d, { branch: "feat/some-human-branch" }).run
    );
    restore!();
    expect(code).toBe(0);
  });

  // The commit is the step that makes the claim real. A repo whose pre-commit
  // hook rejects the claim must BLOCK, never reach `gh pr create` with a bumped
  // working tree and no commit behind it.
  test("a failing commit stops the claim before the PR is ever opened", async () => {
    const d = scratchRepo();
    const g = recordingGit(d, { fail: "commit" });
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/committing the version claim failed/);
    // ...and it never went on to push a claim it could not commit.
    expect(g.calls.map((c) => c.join(" ")).some((c) => c.includes("push"))).toBe(false);
  });

  // An entry file the agent created but never wrote to. Whitespace is not an
  // entry, and an empty `### Fixed` section is worse than the ticket title.
  test("an entry file containing only whitespace falls back to the ticket title", async () => {
    const d = scratchRepo();
    const entry = join(d, "..", `blank-${process.pid}.md`);
    writeFileSync(entry, "   \n\n\t\n", "utf8");
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--entry-file", entry, "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(0);
    const cl = readFileSync(join(d, "CHANGELOG.md"), "utf8");
    expect(cl).toContain("- Fix the parser (#42)");
    expect(cl).not.toMatch(/### Fixed\n\n\n/); // never an empty section
    rmSync(entry, { force: true });
  });

  // --title omitted: the PR title still carries the claimed version, sourced
  // from the board rather than left blank.
  test("with no --title the PR title is built from the ticket's own title", async () => {
    const d = scratchRepo();
    const titleOut = join(d, "..", `t2-${process.pid}.txt`);
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--title-out", titleOut, "--dry-run"],
      executor(["bug"], []),
      recordingGit(d).run
    );
    restore!();
    expect(code).toBe(0);
    expect(readFileSync(titleOut, "utf8")).toBe("v1.0.2.0 Fix the parser");
    rmSync(titleOut, { force: true });
  });

  // The entry guard sits at the CLI boundary, so a forged heading BLOCKS the
  // merge and leaves the branch exactly as it was -- never half-claimed.
  test("a forged version heading in the entry file blocks the claim and writes nothing", async () => {
    const d = scratchRepo();
    const entry = join(d, "..", `forged-${process.pid}.md`);
    writeFileSync(entry, "- did a thing\n\n## [9.9.9.9] - 2020-01-01\n", "utf8");
    const g = recordingGit(d);
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--entry-file", entry, "--date", "2026-08-06"],
      executor(["bug"], []),
      g.run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/contains its own version heading/);
    expect(readFileSync(join(d, "VERSION"), "utf8")).toBe("1.0.1.0\n");
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toBe(CL_PLAIN);
    expect(g.calls.map((c) => c.join(" ")).some((c) => c.includes("commit"))).toBe(false);
    rmSync(entry, { force: true });
  });

  test("a base VERSION that is not a four-segment version is a loud refusal", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { baseVersion: "1.0.1" }).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/not a MAJOR\.MINOR\.PATCH\.MICRO version/);
  });

  test("a failing fetch stops before any decision -- a stale base is not a base", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main"],
      executor(["bug"], []),
      recordingGit(d, { fail: "fetch" }).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/fetching origin\/main failed/);
  });

  test("a failing push is a nonzero exit, not a silent local-only claim", async () => {
    const d = scratchRepo();
    capture();
    const code = await run(
      ["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "2026-08-06"],
      executor(["bug"], []),
      recordingGit(d, { fail: "push" }).run
    );
    restore!();
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/pushing the version claim failed/);
  });

  test("a missing worktree, a bad ticket and a bad date are usage errors, not crashes", async () => {
    capture();
    const bad = join(tmpdir(), `zstack-nope-${process.pid}`);
    expect(await run(["claim", "--ticket", "42", "--worktree", bad, "--base", "main"], executor([], []), recordingGit(bad).run)).toBe(1);
    const d = scratchRepo();
    expect(await run(["claim", "--ticket", "x", "--worktree", d, "--base", "main"], executor([], []), recordingGit(d).run)).toBe(1);
    expect(await run(["claim", "--ticket", "42", "--worktree", d, "--base", "main", "--date", "08/06/26"], executor([], []), recordingGit(d).run)).toBe(1);
    restore!();
    expect(errs.join("\n")).toMatch(/does not exist/);
    expect(errs.join("\n")).toMatch(/must be an issue number/);
    expect(errs.join("\n")).toMatch(/must be YYYY-MM-DD/);
  });

  test("an unknown command and a bare invocation both refuse with usage", async () => {
    capture();
    expect(await run(["bump"], executor([], []), recordingGit("").run)).toBe(1);
    expect(await run([], executor([], []), recordingGit("").run)).toBe(1);
    expect(await run(["help"], executor([], []), recordingGit("").run)).toBe(0);
    restore!();
    expect(errs.join("\n")).toMatch(/Unknown command "bump"/);
  });
});

// -- config -------------------------------------------------------------------

describe("versionBumpLabels config", () => {
  const base = { ...CFG, statusField: CFG.statusField, fields: {} } as any;

  test("a valid map passes and an empty map is legal", () => {
    expect(() => validateConfig({ ...base, versionBumpLabels: { chore: "micro", breaking: "major" } })).not.toThrow();
    expect(() => validateConfig({ ...base, versionBumpLabels: {} })).not.toThrow();
    expect(() => validateConfig({ ...base })).not.toThrow(); // absent = shipped defaults
  });

  // A typo'd level would otherwise surface as a silent MICRO on the one ticket
  // that earned a MAJOR -- discovered at release time, not config time.
  test("a bad level, a bad shape, and an empty key are all refused by name", () => {
    expect(() => validateConfig({ ...base, versionBumpLabels: { bug: "PATCH" } })).toThrow(/versionBumpLabels\.bug/);
    expect(() => validateConfig({ ...base, versionBumpLabels: { bug: "huge" } })).toThrow(/major, minor, patch, micro/);
    expect(() => validateConfig({ ...base, versionBumpLabels: [] })).toThrow(/not an array/);
    expect(() => validateConfig({ ...base, versionBumpLabels: { "  ": "major" } })).toThrow(/empty label key/);
  });
});

// -- the contract the whole feature exists to satisfy -------------------------

// gstack's /review reads a PR's claimed version off the BRANCH
// (`git show HEAD:VERSION`) and compares it to the next free slot. These are the
// two properties that check depends on.
describe("the /review queue contract", () => {
  test("a claimed branch reads STRICTLY above its base, so the claim is visible at all", () => {
    const p = planClaim({ base: v("1.0.1.0"), branch: v("1.0.1.0"), fork: v("1.0.1.0"), claimed: [], labels: [] });
    expect(compareVersions(v(p.version), v("1.0.1.0"))).toBeGreaterThan(0);
  });

  test("two branches claiming in sequence never collide, whichever lands first", () => {
    const base = v("1.0.1.0");
    const a = planClaim({ base, branch: base, fork: base, claimed: [], labels: ["bug"] });
    // B claims while A's PR is open and unmerged.
    const b = planClaim({
      base,
      branch: base,
      fork: base,
      claimed: [{ pr: 1, branch: "a", version: a.version }],
      labels: ["enhancement"],
    });
    expect(a.version).not.toBe(b.version);
    expect(compareVersions(v(b.version), v(a.version))).toBeGreaterThan(0);
  });

  // Review finding, enum completeness. BUMP_ORDER used to be a hand-written
  // Bump[] literal: adding a fifth level would COMPILE with it missing, indexOf
  // would answer -1, and the highest-label-wins comparison would silently rank
  // the new level below micro. It is derived from a Record<Bump, number> now, so
  // the omission is a type error instead.
  test("BUMP_ORDER covers every Bump level, least- to most-significant", () => {
    expect(BUMP_ORDER).toEqual(["micro", "patch", "minor", "major"]);
    // Every level the shipped map can produce is rankable -- no -1 sentinels.
    for (const level of Object.values(DEFAULT_BUMP_LABELS)) {
      expect(BUMP_ORDER.indexOf(level)).toBeGreaterThan(-1);
    }
    expect(BUMP_ORDER.indexOf(FALLBACK_BUMP)).toBeGreaterThan(-1);
  });

  test("the shipped default map is exactly the documented four levels", () => {
    expect(new Set(Object.values(DEFAULT_BUMP_LABELS))).toEqual(new Set(["major", "minor", "patch"]));
    expect(DEFAULT_BUMP_LABELS.bug).toBe("patch");
    expect(DEFAULT_BUMP_LABELS.enhancement).toBe("minor");
    expect(DEFAULT_BUMP_LABELS.breaking).toBe("major");
  });
});
