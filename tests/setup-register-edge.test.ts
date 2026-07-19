// Edge-branch gate tests for ./setup's register(): the separate-install
// discriminator (.git presence) and the per-skill loop's guards, plus the
// Windows copy filter on a synthetic pack (scaffold.test.ts only asserts
// node_modules/.git against the real repo; .worktrees/.gstack were
// unasserted). Scenarios launch concurrently at module load to stay inside
// the gate budget on Windows (~1s per bash spawn).
import { test, expect, describe, afterAll } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, makePack, runSetup } from "./helpers/setup-harness.ts";

const roots: string[] = [];
afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// Scenario D1: skills/zstack holds a SEPARATE real clone (has .git). setup
// must not touch it — but the per-skill entries still register from the pack
// the user explicitly ran.
const scenarioD1 = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  const separate = join(env.skills, "zstack");
  mkdirSync(join(separate, ".git"), { recursive: true });
  writeFileSync(join(separate, "marker"), "other install\n");
  const run = await runSetup(packDir, env);
  return { env, separate, run };
})();

// Scenario D2: skills/zstack is a stale .git-less real dir (a prior run's
// Windows copy). That's ours — it gets refreshed, not skipped.
const scenarioD2 = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  const stale = join(env.skills, "zstack");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "marker"), "stale copy\n");
  const run = await runSetup(packDir, env);
  return { env, stale, run };
})();

// Scenario E: a z-* dir without SKILL.md is not a skill (loop `continue`),
// and on Windows the copy filter drops all four baggage names, not just the
// two scaffold.test.ts checks against the real repo.
const scenarioE = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  mkdirSync(join(packDir, "z-nofile"), { recursive: true }); // no SKILL.md
  for (const baggage of [".git", "node_modules", ".worktrees", ".gstack"]) {
    mkdirSync(join(packDir, baggage), { recursive: true });
    writeFileSync(join(packDir, baggage, "junk"), "x\n");
  }
  const run = await runSetup(packDir, env);
  return { env, run };
})();

describe("setup register edge branches", () => {
  test("a separate clone (with .git) at skills/zstack is left alone, but skills still register", async () => {
    const { env, separate, run } = await scenarioD1;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("separate zstack clone");
    expect(readFileSync(join(separate, "marker"), "utf8")).toContain("other install");
    expect(existsSync(join(separate, ".git"))).toBe(true);
    // The user ran THIS pack's setup — its skills register regardless.
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
  });

  test("a stale .git-less copy at skills/zstack is refreshed, not misread as separate", async () => {
    const { env, stale, run } = await scenarioD2;
    expect(run.code).toBe(0);
    expect(existsSync(join(stale, "marker"))).toBe(false); // replaced
    expect(existsSync(join(stale, "setup"))).toBe(true); // pack content present
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
  });

  test("z-* dir without SKILL.md is skipped; Windows copy filters all baggage", async () => {
    const { env, run } = await scenarioE;
    expect(run.code).toBe(0);
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(env.skills, "z-nofile"))).toBe(false);
    // On macOS/Linux the pack entry is a symlink into the pack, so baggage is
    // visible through it by design — the filter only applies to copies.
    if (process.platform === "win32") {
      for (const baggage of [".git", "node_modules", ".worktrees", ".gstack"]) {
        expect(existsSync(join(env.skills, "zstack", baggage))).toBe(false);
      }
    }
  });
});
