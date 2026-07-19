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

// Scenario D1: skills/zstack holds a SEPARATE real clone (.git dir). That
// checkout owns the host — every SKILL.md resolves PACK to this path, so
// registering another pack's skills next to it would mix versions. setup
// must refuse the whole host and print the resolution.
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

// Scenario D1b: same, but .git is a FILE — the layout `git worktree add`
// produces. Treating only .git DIRECTORIES as checkouts would rm -rf a
// developer's worktree checkout, destroying uncommitted work.
const scenarioD1b = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  const worktree = join(env.skills, "zstack");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: /somewhere/else/.git/worktrees/zstack\n");
  writeFileSync(join(worktree, "marker"), "uncommitted work\n");
  const run = await runSetup(packDir, env);
  return { env, worktree, run };
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
  test("a separate clone (.git dir) at skills/zstack refuses the host: nothing touched, nothing mixed", async () => {
    const { env, separate, run } = await scenarioD1;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("separate zstack checkout");
    expect(readFileSync(join(separate, "marker"), "utf8")).toContain("other install");
    expect(existsSync(join(separate, ".git"))).toBe(true);
    // No per-skill entries from THIS pack — that checkout owns the host.
    expect(existsSync(join(env.skills, "z-alpha"))).toBe(false);
  });

  test("a worktree checkout (.git FILE) at skills/zstack is refused too, never rm -rf'd", async () => {
    const { env, worktree, run } = await scenarioD1b;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("separate zstack checkout");
    expect(readFileSync(join(worktree, "marker"), "utf8")).toContain("uncommitted work");
    expect(existsSync(join(env.skills, "z-alpha"))).toBe(false);
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
