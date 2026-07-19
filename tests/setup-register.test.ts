// Gate tests for ./setup's skill registration. Claude Code (and Codex/Factory)
// build the skill list from skills_dir/<name>/SKILL.md exactly ONE level deep,
// so the pack dir alone is invisible: setup must register every z-* skill as a
// top-level entry. Regression for "installed zstack but the skills don't
// appear" — the cloned-straight-into-~/.claude/skills/zstack path used to
// early-return before registering anything.
//
// Runs the real script via bash against a throwaway $HOME with a stubbed gh,
// so it's deterministic, network-free, and inside the gate budget. Windows
// bash spawns cost ~1s each, so the three scenarios launch concurrently at
// module load and each test just awaits its result.
import { test, expect, describe, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETUP_SRC = join(import.meta.dir, "..", "setup");

const roots: string[] = [];
afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "zstack-setup-reg-"));
  roots.push(root);
  const home = join(root, "home");
  const skills = join(home, ".claude", "skills");
  mkdirSync(join(skills, "gstack"), { recursive: true }); // precondition gate
  const stubBin = join(root, "stub-bin");
  mkdirSync(stubBin);
  writeFileSync(join(stubBin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, home, skills, stubBin };
}

// A minimal pack: the real setup script plus synthetic z-* skills, so the test
// pins the registration contract without copying the whole repo around.
function makePack(dir: string, skillNames: string[]) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(SETUP_SRC, join(dir, "setup"));
  for (const name of skillNames) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: test skill\n---\nbody\n`
    );
  }
}

async function runSetup(packDir: string, env: { home: string; stubBin: string }) {
  const proc = Bun.spawn(
    ["bash", join(packDir, "setup").replaceAll("\\", "/")],
    {
      env: {
        ...process.env,
        HOME: env.home,
        PATH: `${env.stubBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// Scenario A (the reported bug): pack cloned straight into the skills dir,
// run twice to also pin idempotence (the documented Windows update path).
const scenarioA = (async () => {
  const env = makeEnv();
  const packDir = join(env.skills, "zstack");
  makePack(packDir, ["z-alpha", "z-beta"]);
  const first = await runSetup(packDir, env);
  const second = await runSetup(packDir, env);
  return { env, packDir, first, second };
})();

// Scenario B: pack cloned elsewhere.
const scenarioB = (async () => {
  const env = makeEnv();
  const packRoot = mkdtempSync(join(tmpdir(), "zstack-pack-"));
  roots.push(packRoot);
  const packDir = join(packRoot, "zstack");
  makePack(packDir, ["z-alpha"]);
  const run = await runSetup(packDir, env);
  return { env, run };
})();

// Scenario C: a colliding skill dir owned by someone else.
const scenarioC = (async () => {
  const env = makeEnv();
  const packDir = join(env.skills, "zstack");
  makePack(packDir, ["z-alpha", "z-beta"]);
  const foreign = join(env.skills, "z-alpha");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "SKILL.md"), "---\nname: not-ours\n---\nkeep me\n");
  const run = await runSetup(packDir, env);
  return { env, foreign, run };
})();

describe("setup registers each skill one level deep", () => {
  test("cloned straight into ~/.claude/skills/zstack: z-* entries appear (the reported bug), re-run idempotent", async () => {
    const { env, packDir, first, second } = await scenarioA;
    expect(first.code).toBe(0);
    for (const name of ["z-alpha", "z-beta"]) {
      expect(existsSync(join(env.skills, name, "SKILL.md"))).toBe(true);
    }
    expect(first.stdout).toContain("z-alpha");
    // The pack itself must survive (the old early-return existed to avoid
    // self-clobbering; the fix keeps that while adding per-skill entries).
    expect(existsSync(join(packDir, "setup"))).toBe(true);
    expect(second.code).toBe(0);
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
  });

  test("cloned elsewhere: pack registered as skills/zstack plus top-level z-* entries", async () => {
    const { env, run } = await scenarioB;
    expect(run.code).toBe(0);
    expect(existsSync(join(env.skills, "zstack", "setup"))).toBe(true);
    expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
  });

  test("a colliding non-zstack skill dir is left untouched", async () => {
    const { env, foreign, run } = await scenarioC;
    expect(run.code).toBe(0);
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toContain("keep me");
    expect(run.stderr).toContain("not a zstack skill");
    // The non-colliding sibling still registered.
    expect(existsSync(join(env.skills, "z-beta", "SKILL.md"))).toBe(true);
  });
});
