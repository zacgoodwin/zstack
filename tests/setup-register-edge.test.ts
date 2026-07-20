// Edge-branch gate tests for ./setup's register(): the ownership sentinel
// (.zstack-registered) that separates our registrations from anything a user
// or another tool put there, plus the per-skill loop's guards and the Windows
// copy filter on a synthetic pack (scaffold.test.ts only asserts
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
// registering another pack's skills next to it would mix versions. setup must
// refuse the whole host AND skip Codex/Factory (their skills would execute
// the conflicting runtime too — a codex stub is on PATH to prove the skip).
const scenarioD1 = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  writeFileSync(join(env.stubBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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

// Scenario D2: skills/zstack is a stale sentinel-carrying real dir (a prior
// run's Windows copy). That's provably ours — it gets refreshed, not skipped.
const scenarioD2 = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  const stale = join(env.skills, "zstack");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, ".zstack-registered"), "");
  writeFileSync(join(stale, "marker"), "stale copy\n");
  const run = await runSetup(packDir, env);
  return { env, stale, run };
})();

// Scenario D3: skills/zstack is a real dir with NO sentinel and NO .git — a
// ZIP/manual install. Codex [P1]: a .git-only discriminator would misread it
// as our stale copy and rm -rf someone's hand-managed install.
const scenarioD3 = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  const manual = join(env.skills, "zstack");
  mkdirSync(manual, { recursive: true });
  writeFileSync(join(manual, "marker"), "zip install, local edits\n");
  const run = await runSetup(packDir, env);
  return { env, manual, run };
})();

// Scenario D4: a THIRD-PARTY skill at skills/z-alpha whose frontmatter
// legitimately declares `name: z-alpha` (that's what makes it that skill) and
// which carries its own .git and local work. Name-matching can't tell it from
// ours — only the sentinel can. Pre-sentinel setup rm -rf'd it silently.
const scenarioD4 = (async () => {
  const env = makeEnv(roots, "zstack-setup-edge-");
  const packDir = join(env.skills, "zstack");
  makePack(packDir, ["z-alpha"]);
  const foreign = join(env.skills, "z-alpha");
  mkdirSync(join(foreign, ".git"), { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: z-alpha\n---\nsomeone else's z-alpha\n");
  writeFileSync(join(foreign, "my-notes.md"), "uncommitted notes\n");
  const run = await runSetup(packDir, env);
  return { env, foreign, run };
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
  test("a separate clone (.git dir) refuses the host and skips Codex/Factory too", async () => {
    const { env, separate, run } = await scenarioD1;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("separate zstack install");
    expect(readFileSync(join(separate, "marker"), "utf8")).toContain("other install");
    expect(existsSync(join(separate, ".git"))).toBe(true);
    // No per-skill entries from THIS pack — that checkout owns the host.
    expect(existsSync(join(env.skills, "z-alpha"))).toBe(false);
    // And no Codex registration either, despite codex being on PATH: its
    // skills would execute the conflicting ~/.claude runtime (Codex P2).
    expect(run.stderr).toContain("Skipping Codex/Factory");
    expect(existsSync(join(env.home, ".codex", "skills"))).toBe(false);
  });

  test("a worktree checkout (.git FILE) at skills/zstack is refused too, never rm -rf'd", async () => {
    const { env, worktree, run } = await scenarioD1b;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("separate zstack install");
    expect(readFileSync(join(worktree, "marker"), "utf8")).toContain("uncommitted work");
    expect(existsSync(join(env.skills, "z-alpha"))).toBe(false);
  });

  test("a stale sentinel-carrying copy at skills/zstack is refreshed", async () => {
    const { env, stale, run } = await scenarioD2;
    expect(run.code).toBe(0);
    expect(existsSync(join(stale, "marker"))).toBe(false); // replaced
    expect(existsSync(join(stale, "setup"))).toBe(true); // pack content present
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
  });

  test("a manual install without sentinel or .git is refused, not misread as our copy", async () => {
    const { env, manual, run } = await scenarioD3;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("separate zstack install");
    expect(readFileSync(join(manual, "marker"), "utf8")).toContain("zip install");
    expect(existsSync(join(env.skills, "z-alpha"))).toBe(false);
  });

  test("a third-party skill legitimately named z-alpha is never clobbered by the refresh", async () => {
    const { env, foreign, run } = await scenarioD4;
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("not registered by zstack setup");
    expect(readFileSync(join(foreign, "my-notes.md"), "utf8")).toContain("uncommitted notes");
    expect(existsSync(join(foreign, ".git"))).toBe(true);
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
