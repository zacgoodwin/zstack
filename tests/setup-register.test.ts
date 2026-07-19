// Gate tests for ./setup's skill registration. Claude Code (and Codex/Factory)
// build the skill list from skills_dir/<name>/SKILL.md exactly ONE level deep,
// so the pack dir alone is invisible: setup must register every z-* skill as a
// top-level entry. Regression for "installed zstack but the skills don't
// appear" — the cloned-straight-into-~/.claude/skills/zstack path used to
// early-return before registering anything.
//
// Scenarios launch concurrently at module load (Windows bash spawns cost ~1s
// each) and each test just awaits its result. Harness: tests/helpers/setup-harness.ts.
import { test, expect, describe, afterAll } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnv, makePack, runSetup } from "./helpers/setup-harness.ts";

const roots: string[] = [];
afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// Scenario A (the reported bug): pack cloned straight into the skills dir,
// run twice to also pin idempotence (the documented Windows update path).
const scenarioA = (async () => {
  const env = makeEnv(roots);
  const packDir = join(env.skills, "zstack");
  makePack(packDir, ["z-alpha", "z-beta"]);
  const first = await runSetup(packDir, env);
  const second = await runSetup(packDir, env);
  return { env, packDir, first, second };
})();

// Scenario B: pack cloned elsewhere, run twice. The re-run must REFRESH the
// registered copies — pre-fix, the separate-install guard misread our own
// .git-free Windows copy as a foreign install and silently updated nothing,
// breaking the documented "re-run ./setup after git pull" flow.
const scenarioB = (async () => {
  const env = makeEnv(roots);
  const packRoot = mkdtempSync(join(tmpdir(), "zstack-pack-"));
  roots.push(packRoot);
  const packDir = join(packRoot, "zstack");
  makePack(packDir, ["z-alpha"]);
  const first = await runSetup(packDir, env);
  // Plant a sentinel in the registered pack copy; a real refresh removes it.
  // Only meaningful on Windows — on POSIX the registration is a symlink and
  // writing through it would mutate the source pack.
  const sentinel = join(env.skills, "zstack", "stale-sentinel");
  if (process.platform === "win32") writeFileSync(sentinel, "stale\n");
  const second = await runSetup(packDir, env);
  return { env, sentinel, first, second };
})();

// Scenario C: a colliding skill dir owned by someone else (frontmatter name
// mismatch) must be left untouched — including the near-miss where the foreign
// name merely EXTENDS ours ("z-alpha-extended" in a dir named z-alpha), which
// an unanchored grep would misread as ours and clobber.
const scenarioC = (async () => {
  const env = makeEnv(roots);
  const packDir = join(env.skills, "zstack");
  makePack(packDir, ["z-alpha", "z-beta", "z-gamma"]);
  const foreign = join(env.skills, "z-alpha");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: not-ours\n---\nkeep me\n");
  const nearMiss = join(env.skills, "z-gamma");
  mkdirSync(nearMiss, { recursive: true });
  writeFileSync(join(nearMiss, "SKILL.md"), "---\nname: z-gamma-extended\n---\nkeep me too\n");
  const run = await runSetup(packDir, env);
  return { env, foreign, nearMiss, run };
})();

// Scenario F: EVERY pack skill collides with a foreign dir. Pre-fix, the
// empty-registration summary (`[ -n ] && echo` as register()'s last command
// under set -e) aborted the whole script with exit 1.
const scenarioF = (async () => {
  const env = makeEnv(roots);
  const packDir = join(env.skills, "zstack");
  makePack(packDir, ["z-alpha"]);
  const foreign = join(env.skills, "z-alpha");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: not-ours\n---\nkeep me\n");
  const run = await runSetup(packDir, env);
  return { env, run };
})();

describe("setup registers each skill one level deep", () => {
  test("cloned straight into ~/.claude/skills/zstack: z-* entries appear (the reported bug), re-run idempotent", async () => {
    const { env, packDir, first, second } = await scenarioA;
    expect(first.code).toBe(0);
    for (const name of ["z-alpha", "z-beta"]) {
      expect(existsSync(join(env.skills, name, "SKILL.md"))).toBe(true);
    }
    expect(first.stdout).toContain("z-alpha");
    // The pack itself must survive (the pack-parent guard exists to avoid
    // self-clobbering; the fix keeps that while adding per-skill entries).
    expect(existsSync(join(packDir, "setup"))).toBe(true);
    expect(second.code).toBe(0);
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
  });

  test("cloned elsewhere: pack + z-* entries registered, and a re-run refreshes the copies", async () => {
    const { env, sentinel, first, second } = await scenarioB;
    expect(first.code).toBe(0);
    expect(existsSync(join(env.skills, "zstack", "setup"))).toBe(true);
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
    expect(second.code).toBe(0);
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
    if (process.platform === "win32") {
      // The refresh replaced our stale copy — the sentinel is gone.
      expect(existsSync(sentinel)).toBe(false);
    }
  });

  test("colliding non-zstack skill dirs are left untouched, including a name-prefix near-miss", async () => {
    const { env, foreign, nearMiss, run } = await scenarioC;
    expect(run.code).toBe(0);
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toContain("keep me");
    expect(readFileSync(join(nearMiss, "SKILL.md"), "utf8")).toContain("keep me too");
    expect(run.stderr).toContain("not a zstack skill");
    // The non-colliding sibling still registered.
    expect(existsSync(join(env.skills, "z-beta", "SKILL.md"))).toBe(true);
  });

  test("all skills colliding is a warning, not a fatal exit (set -e regression)", async () => {
    const { run } = await scenarioF;
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("zstack setup complete.");
    expect(run.stderr).toContain("not a zstack skill");
  });

  test.skipIf(process.platform === "win32")(
    "POSIX: an owned real dir at the destination is replaced by a symlink, not nested into",
    async () => {
      // ln -snf into an existing real dir would nest the link INSIDE it,
      // leaving stale skill content live. _link_or_copy must replace it.
      const env = makeEnv(roots);
      const packDir = join(env.skills, "zstack");
      makePack(packDir, ["z-alpha"]);
      const stale = join(env.skills, "z-alpha");
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, "SKILL.md"), "---\nname: z-alpha\n---\nold copy\n");
      const run = await runSetup(packDir, env);
      expect(run.code).toBe(0);
      expect(lstatSync(stale).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(stale, "SKILL.md"), "utf8")).toContain("test skill");
    }
  );

  test("real z-*/SKILL.md files keep `name:` inside the head -3 window setup parses", () => {
    // The Windows refresh path greps the first 3 lines for `name: <dir>`;
    // reordering frontmatter would silently demote every re-run to "not a
    // zstack skill". Pin the contract against the real skill files.
    const repoRoot = join(import.meta.dir, "..");
    const skillDirs = readdirSync(repoRoot).filter((d) => d.startsWith("z-"));
    expect(skillDirs.length).toBeGreaterThanOrEqual(4);
    for (const dir of skillDirs) {
      const head = readFileSync(join(repoRoot, dir, "SKILL.md"), "utf8")
        .split("\n")
        .slice(0, 3);
      expect(head.some((l) => l.trimEnd() === `name: ${dir}`)).toBe(true);
    }
  });
});
