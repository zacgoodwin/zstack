// Gate tests for lib/spec-sources.ts (issue #16: /z-plan input should ingest
// all gstack project documents, not just the newest ceo-plans file). Covers
// kind filtering, newest-first ordering within a kind, the kind-precedence
// group order (specs/ceo-plans before test-plan/checkpoints), the equal-mtime
// tiebreak, non-md exclusion, the empty-dir error naming every searched
// directory (AC3), determinism across two runs (AC4), and the CLI's exit
// codes. Deterministic, fixture temp dirs only, no network.
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSpecSources, main, searchedDirs, ZError, type SpecSource } from "../lib/spec-sources.ts";

const dirs: string[] = [];
function projectDir(): string {
  const d = mkdtempSync(join(tmpdir(), "zstack-spec-sources-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Writes a file and stamps it with an explicit mtime (both atime and mtime,
// utimesSync requires both) -- real fs write timestamps are too close together
// (and on some filesystems too coarse) to trust for ordering assertions, so
// every ordering/tiebreak test controls mtime explicitly rather than relying
// on write order.
function fileAt(path: string, mtimeMs: number, content = "content"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("discoverSpecSources: kind filtering", () => {
  test("assigns the correct kind to each of the four categories", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "a.md"), T0);
    fileAt(join(dir, "ceo-plans", "b.md"), T0);
    fileAt(join(dir, "app-test-plan-v1.md"), T0);
    fileAt(join(dir, "checkpoints", "c.md"), T0);

    const sources = discoverSpecSources(dir);
    const byKind = Object.fromEntries(sources.map((s) => [s.kind, s.path]));
    expect(byKind["specs"]).toBe(join(dir, "specs", "a.md"));
    expect(byKind["ceo-plans"]).toBe(join(dir, "ceo-plans", "b.md"));
    expect(byKind["test-plan"]).toBe(join(dir, "app-test-plan-v1.md"));
    expect(byKind["checkpoints"]).toBe(join(dir, "checkpoints", "c.md"));
    expect(sources).toHaveLength(4);
  });

  test("non-md files are ignored in every category", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "a.md"), T0);
    fileAt(join(dir, "specs", "notes.txt"), T0);
    fileAt(join(dir, "ceo-plans", "readme.png"), T0);
    fileAt(join(dir, "checkpoints", "scratch.json"), T0);
    // Loose root file that looks md but doesn't carry "-test-plan-" -- not a
    // recognized category (root is only scanned for the test-plan pattern).
    fileAt(join(dir, "random-notes.md"), T0);
    // Wrong extension for the test-plan pattern.
    fileAt(join(dir, "app-test-plan-v1.txt"), T0);

    const sources = discoverSpecSources(dir);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe(join(dir, "specs", "a.md"));
  });

  test("a directory matching the glob is not treated as a document", () => {
    const dir = projectDir();
    mkdirSync(join(dir, "specs", "a.md"), { recursive: true }); // a DIRECTORY named a.md
    fileAt(join(dir, "specs", "b.md"), T0);

    const sources = discoverSpecSources(dir);
    expect(sources).toHaveLength(1);
    expect(sources[0].path).toBe(join(dir, "specs", "b.md"));
  });

  test("a missing category directory is simply absent, not an error", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "only.md"), T0); // ceo-plans/, checkpoints/ never created
    const sources = discoverSpecSources(dir);
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("specs");
  });
});

describe("discoverSpecSources: newest-first ordering within a kind", () => {
  test("three files in one kind sort newest mtime first", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "oldest.md"), T0);
    fileAt(join(dir, "specs", "newest.md"), T0 + 2 * DAY);
    fileAt(join(dir, "specs", "middle.md"), T0 + DAY);

    const sources = discoverSpecSources(dir);
    expect(sources.map((s) => s.path)).toEqual([
      join(dir, "specs", "newest.md"),
      join(dir, "specs", "middle.md"),
      join(dir, "specs", "oldest.md"),
    ]);
  });

  test("equal mtimes tiebreak on path, ascending", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "zeta.md"), T0);
    fileAt(join(dir, "specs", "alpha.md"), T0);
    fileAt(join(dir, "specs", "mid.md"), T0);

    const sources = discoverSpecSources(dir);
    expect(sources.map((s) => s.path)).toEqual([
      join(dir, "specs", "alpha.md"),
      join(dir, "specs", "mid.md"),
      join(dir, "specs", "zeta.md"),
    ]);
  });
});

describe("discoverSpecSources: kind-group order (specs/ceo-plans before the rest)", () => {
  test("specs and ceo-plans precede test-plan and checkpoints regardless of cross-kind mtime", () => {
    const dir = projectDir();
    // checkpoints is the OLDEST-written category here but must still sort
    // after every specs/ceo-plans entry -- kind order is fixed, not
    // re-derived from mtime across kinds (only within a kind).
    fileAt(join(dir, "checkpoints", "c.md"), T0 + 10 * DAY); // newest overall
    fileAt(join(dir, "app-test-plan-v1.md"), T0 + 5 * DAY);
    fileAt(join(dir, "ceo-plans", "b.md"), T0 + 1 * DAY);
    fileAt(join(dir, "specs", "a.md"), T0); // oldest overall

    const sources = discoverSpecSources(dir);
    expect(sources.map((s) => s.kind)).toEqual(["specs", "ceo-plans", "test-plan", "checkpoints"]);
  });
});

describe("discoverSpecSources: empty result (AC3)", () => {
  test("no planning documents anywhere -> throws naming every searched directory", () => {
    const dir = projectDir();
    expect(() => discoverSpecSources(dir)).toThrow(ZError);
    try {
      discoverSpecSources(dir);
      throw new Error("expected discoverSpecSources to throw");
    } catch (e) {
      const msg = (e as ZError).message;
      for (const searched of searchedDirs(dir)) expect(msg).toContain(searched);
    }
  });

  test("searchedDirs lists all four category directories, in kind order", () => {
    const dir = projectDir();
    expect(searchedDirs(dir)).toEqual([
      join(dir, "specs"),
      join(dir, "ceo-plans"),
      dir, // test-plan: the project dir itself
      join(dir, "checkpoints"),
    ]);
  });

  test("an irrelevant file alone (no category match) still counts as empty", () => {
    const dir = projectDir();
    fileAt(join(dir, "README.md"), T0);
    expect(() => discoverSpecSources(dir)).toThrow(ZError);
  });
});

describe("discoverSpecSources: determinism (AC4/AC5)", () => {
  test("two runs over the same dir produce byte-identical JSON", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "a.md"), T0 + DAY);
    fileAt(join(dir, "specs", "b.md"), T0 + DAY); // ties with a.md
    fileAt(join(dir, "ceo-plans", "c.md"), T0);
    fileAt(join(dir, "app-x-test-plan-1.md"), T0);
    fileAt(join(dir, "checkpoints", "d.md"), T0);

    const first = JSON.stringify(discoverSpecSources(dir));
    const second = JSON.stringify(discoverSpecSources(dir));
    expect(first).toBe(second);
  });
});

// -- CLI (bun lib/spec-sources.ts <dir>) --------------------------------------
describe("spec-sources CLI (main)", () => {
  let logs: ReturnType<typeof spyOn>;
  let errs: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logs = spyOn(console, "log").mockImplementation(() => {});
    errs = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logs.mockRestore();
    errs.mockRestore();
  });

  test("prints the JSON list and exits 0", () => {
    const dir = projectDir();
    fileAt(join(dir, "specs", "a.md"), T0);
    expect(main([dir])).toBe(0);
    expect(logs).toHaveBeenCalled();
    const printed = logs.mock.calls[0][0] as string;
    const parsed = JSON.parse(printed) as SpecSource[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("specs");
  });

  test("empty project dir exits 1 and prints the searched-dirs message to stderr", () => {
    const dir = projectDir();
    expect(main([dir])).toBe(1);
    expect(errs).toHaveBeenCalled();
    const printed = errs.mock.calls[0][0] as string;
    expect(printed).toContain(join(dir, "specs"));
    expect(printed).toContain(join(dir, "ceo-plans"));
    expect(printed).toContain(join(dir, "checkpoints"));
  });

  test("no argument prints usage and exits 1", () => {
    expect(main([])).toBe(1);
    expect(logs).toHaveBeenCalled();
  });

  test("--help prints usage and exits 0", () => {
    expect(main(["--help"])).toBe(0);
  });
});
