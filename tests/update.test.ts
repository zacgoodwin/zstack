// Gate tests for ticket #36: the `bin/z-update` script, driven through real
// bash against real local git fixtures (a bare "origin" plus a working clone
// -- no network, no GitHub). Style follows tests/uninstall.test.ts (throwaway
// $HOME, explicit PATH) and reuses tests/helpers/setup-harness.ts so the
// re-exec into a REAL `setup` is exercised end to end, not stubbed.
//
// One case per plan AC:
//   AC1 - symlinked registration -> a local clone behind its origin: pulled,
//         setup re-runs, old -> new VERSION printed, exit 0.
//   AC2 - a sentinel copy whose marker names the source clone: same outcome,
//         resolved via the marker instead of a symlink.
//   AC3 - no resolvable git source (legacy empty marker / no marker / no
//         .git anywhere): exits non-zero with a reinstall message, nothing
//         on disk touched.
//   AC4 - `git pull --ff-only` fails on diverged history: stops before
//         setup runs, surfaces git's error, pre-existing registrations
//         untouched.
//   AC5 - (setup, not z-update) each marker `./setup`'s copy path creates
//         contains the clone's absolute path.
//
// Scenarios kick off concurrently at module load (each bash spawn costs
// ~1s on Windows) so the suite doesn't serialize five separate bash spawns.
import { test, expect, describe, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { toPosixPath, makeEnv, makePack, type SetupEnv } from "./helpers/setup-harness.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const Z_UPDATE_SRC = join(REPO_ROOT, "bin", "z-update");

const BASH = Bun.which("bash");
if (!BASH) throw new Error("bash not found on PATH: required to exercise bin/z-update");
const GIT_BIN = Bun.which("git");
if (!GIT_BIN) throw new Error("git not found on PATH: required to build test fixtures");

function binDir(name: string): string {
  const resolved = Bun.which(name);
  if (!resolved) throw new Error(`${name} not found on PATH: required to build test fixtures`);
  return toPosixPath(dirname(resolved));
}
const BUN_DIR = binDir("bun");
const CORE_DIR = binDir("uname"); // coreutils: mkdir, cp, rm, printf, sed, cat on the fixture PATH
const GIT_DIR = binDir("git");

const roots: string[] = [];
afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// -- git fixture helpers ------------------------------------------------

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync([GIT_BIN!, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "zstack-test",
      GIT_AUTHOR_EMAIL: "test@zstack.local",
      GIT_COMMITTER_NAME: "zstack-test",
      GIT_COMMITTER_EMAIL: "test@zstack.local",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}) failed:\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

function setVersion(dir: string, version: string) {
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
}

// Appends harmless padding to bin/z-update itself, so the "ahead" commit's
// `git pull` rewrites the running script's OWN bytes mid-run (69 -> 269
// lines, shifting every downstream byte offset) instead of only bumping
// VERSION -- the exact self-replacement hazard the main(){...}; main "$@"
// wrapper (bin/z-update:5-14/56-69) exists to defend against. 200 lines
// matches the scale a hand-built fixture already confirmed the wrapper
// survives (pull rewrites bin/z-update mid-run, script still completes:
// version bump printed, setup exec'd, exit 0).
function padSelf(dir: string) {
  const path = join(dir, "bin", "z-update");
  const padding = Array.from({ length: 200 }, (_, i) => `# padding ${i}`).join("\n");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${padding}\n`);
}

// A commit carrying the real `setup`, a real `bin/z-update`, a VERSION file,
// and a fixture skill -- the minimum a `git pull` + re-exec'd setup needs.
function seedPackCommit(dir: string, version: string, message: string) {
  makePack(dir, ["z-alpha"]);
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(Z_UPDATE_SRC, join(dir, "bin", "z-update"));
  setVersion(dir, version);
  git(dir, ["add", "-A"]);
  git(dir, ["update-index", "--chmod=+x", "setup", "bin/z-update"]);
  git(dir, ["commit", "-q", "-m", message]);
}

interface AheadFixture {
  seed: string;
  origin: string; // bare repo, one commit ahead of srcDir
  srcDir: string; // the "installed" clone
}

// Bare origin one commit ahead of a working clone (srcDir): the shape every
// AC needs except AC3/AC5. srcDir starts at v0.1.0; origin moves to v0.2.0.
function makeAheadClone(): AheadFixture {
  const seed = tmp("zstack-update-seed-");
  git(seed, ["init", "-q", "-b", "main"]);
  seedPackCommit(seed, "0.1.0", "v0.1.0");

  const originRoot = tmp("zstack-update-origin-");
  const origin = join(originRoot, "origin.git");
  git(tmpdir(), ["clone", "-q", "--bare", seed, origin]);

  const srcRoot = tmp("zstack-update-src-");
  const srcDir = join(srcRoot, "zstack");
  git(tmpdir(), ["clone", "-q", origin, srcDir]);

  setVersion(seed, "0.2.0");
  padSelf(seed); // exercise the self-replacement hazard, not just a VERSION bump
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "v0.2.0"]);
  git(seed, ["push", "-q", origin, "HEAD:main"]);

  return { seed, origin, srcDir };
}

async function runUpdate(zUpdatePath: string, env: SetupEnv) {
  const childEnv: Record<string, string> = {
    HOME: env.home,
    PATH: `${toPosixPath(env.stubBin)}:${BUN_DIR}:${CORE_DIR}:${GIT_DIR}`,
  };
  for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v) childEnv[key] = v;
  }
  const proc = Bun.spawn([BASH!, zUpdatePath.replaceAll("\\", "/")], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function canSymlink(): boolean {
  const probe = tmp("zstack-update-symprobe-");
  try {
    writeFileSync(join(probe, "target"), "x");
    symlinkSync(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  }
}
const CAN_SYMLINK = canSymlink();

const SPAWN_TIMEOUT_MS = 20000;

// -- AC1: symlinked registration -> local clone behind its origin -----------
// Only built when this machine can create symlinks (Windows without Developer
// Mode can't -- EPERM) -- gated the same way the test below is, so a doomed
// symlinkSync never fires as an unhandled rejection between tests.
const scenario1 = CAN_SYMLINK
  ? (async () => {
      const { srcDir } = makeAheadClone();
      const env = makeEnv(roots, "zstack-update-ac1-");
      symlinkSync(srcDir, join(env.skills, "zstack"));
      const result = await runUpdate(join(env.skills, "zstack", "bin", "z-update"), env);
      return { env, srcDir, result };
    })()
  : null;

// Unconditional companion to AC1 covering the same "PACK_DIR itself is a git
// checkout" resolution path without requiring symlink privileges (Windows
// without Developer Mode can't create them) -- invokes bin/z-update straight
// from inside the clone instead of through a registered symlink.
const scenario1Direct = (async () => {
  const { srcDir } = makeAheadClone();
  const env = makeEnv(roots, "zstack-update-ac1direct-");
  const result = await runUpdate(join(srcDir, "bin", "z-update"), env);
  return { env, srcDir, result };
})();

// -- AC2: sentinel copy, marker names the source clone -----------------------
const scenario2 = (async () => {
  const { srcDir } = makeAheadClone();
  const env = makeEnv(roots, "zstack-update-ac2-");
  const copyDir = join(env.root, "copy", "zstack");
  mkdirSync(join(copyDir, "bin"), { recursive: true });
  cpSync(Z_UPDATE_SRC, join(copyDir, "bin", "z-update"));
  writeFileSync(
    join(copyDir, ".zstack-registered"),
    `Created by zstack ./setup. Safe to remove with ./uninstall (or by deleting this directory).\nsource: ${toPosixPath(srcDir)}\n`
  );
  const result = await runUpdate(join(copyDir, "bin", "z-update"), env);
  return { env, srcDir, copyDir, result };
})();

// -- AC3: no resolvable git source -------------------------------------------
const scenario3Legacy = (async () => {
  const env = makeEnv(roots, "zstack-update-ac3legacy-");
  const copyDir = join(env.root, "legacy-copy", "zstack");
  mkdirSync(join(copyDir, "bin"), { recursive: true });
  cpSync(Z_UPDATE_SRC, join(copyDir, "bin", "z-update"));
  writeFileSync(join(copyDir, ".zstack-registered"), ""); // pre-#36 empty marker
  const before = readdirSync(env.skills).sort();
  const result = await runUpdate(join(copyDir, "bin", "z-update"), env);
  const after = readdirSync(env.skills).sort();
  return { env, copyDir, result, before, after };
})();

const scenario3NoMarker = (async () => {
  const env = makeEnv(roots, "zstack-update-ac3nomarker-");
  const copyDir = join(env.root, "manual-copy", "zstack");
  mkdirSync(join(copyDir, "bin"), { recursive: true });
  cpSync(Z_UPDATE_SRC, join(copyDir, "bin", "z-update")); // ZIP/manual install: no .git, no marker
  const before = readdirSync(env.skills).sort();
  const result = await runUpdate(join(copyDir, "bin", "z-update"), env);
  const after = readdirSync(env.skills).sort();
  return { env, copyDir, result, before, after };
})();

// -- AC4: git pull --ff-only fails on diverged history -----------------------
const scenario4 = (async () => {
  const { srcDir } = makeAheadClone(); // origin already one commit ahead
  setVersion(srcDir, "0.1.0-local"); // srcDir ALSO gains a commit origin lacks
  git(srcDir, ["add", "-A"]);
  git(srcDir, ["commit", "-q", "-m", "local edit"]);

  const env = makeEnv(roots, "zstack-update-ac4-");
  // A pre-existing, unrelated registration: proof a failed update leaves it
  // exactly as it was.
  const existing = join(env.skills, "z-existing");
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, "SKILL.md"), "---\nname: z-existing\n---\nkeep me\n");
  const before = readFileSync(join(existing, "SKILL.md"), "utf8");

  const result = await runUpdate(join(srcDir, "bin", "z-update"), env);
  const after = readFileSync(join(existing, "SKILL.md"), "utf8");
  return { env, srcDir, result, before, after };
})();

// -- AC5: setup's copy path stamps each marker with the clone's abs path -----
const scenario5 = (async () => {
  const env = makeEnv(roots, "zstack-update-ac5-");
  const packDir = join(env.root, "elsewhere", "zstack");
  makePack(packDir, ["z-alpha"]);
  const childEnv: Record<string, string> = {
    HOME: env.home,
    PATH: `${toPosixPath(env.stubBin)}:${BUN_DIR}:${CORE_DIR}`,
  };
  for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v) childEnv[key] = v;
  }
  const proc = Bun.spawn([BASH!, join(packDir, "setup").replaceAll("\\", "/")], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { env, packDir, run: { stdout, stderr, code } };
})();

describe("AC1 -- symlinked pack registration: pulled, setup re-runs, VERSION printed", () => {
  test.skipIf(!CAN_SYMLINK)(
    "a clone registered as a symlink is pulled, setup re-runs, old -> new VERSION shown, exit 0",
    async () => {
      const { srcDir, result } = (await scenario1)!;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("0.1.0");
      expect(result.stdout).toContain("0.2.0");
      expect(result.stdout).toContain("zstack setup complete.");
      expect(readFileSync(join(srcDir, "VERSION"), "utf8").trim()).toBe("0.2.0");
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "invoked directly from inside the clone (no symlink needed): same outcome",
    async () => {
      const { env, srcDir, result } = await scenario1Direct;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("0.1.0");
      expect(result.stdout).toContain("0.2.0");
      expect(result.stdout).toContain("zstack setup complete.");
      expect(readFileSync(join(srcDir, "VERSION"), "utf8").trim()).toBe("0.2.0");
      // setup actually ran against $HOME/.claude/skills: the fixture skill
      // got registered, proving it wasn't just a version bump with no re-run.
      expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
    },
    SPAWN_TIMEOUT_MS
  );
});

describe("AC2 -- sentinel copy: source resolved via the marker", () => {
  test(
    "a copy whose marker names a git-clone source is pulled and setup re-runs",
    async () => {
      const { env, srcDir, result } = await scenario2;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("0.1.0");
      expect(result.stdout).toContain("0.2.0");
      expect(result.stdout).toContain("zstack setup complete.");
      expect(readFileSync(join(srcDir, "VERSION"), "utf8").trim()).toBe("0.2.0");
      expect(existsSync(join(env.skills, "z-alpha", "SKILL.md"))).toBe(true);
    },
    SPAWN_TIMEOUT_MS
  );
});

describe("AC3 -- no resolvable git source: refuses, nothing on disk modified", () => {
  test(
    "a legacy empty marker (pre-#36) with no .git anywhere: exit non-zero, reinstall message, no writes",
    async () => {
      const { result, before, after } = await scenario3Legacy;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("git clone");
      expect(result.stderr).toContain("./setup");
      expect(result.stdout).not.toContain("zstack setup complete.");
      expect(after).toEqual(before); // nothing registered
    },
    SPAWN_TIMEOUT_MS
  );

  test(
    "no marker and no .git at all (ZIP/manual install): exit non-zero, reinstall message, no writes",
    async () => {
      const { result, before, after } = await scenario3NoMarker;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("git clone");
      expect(result.stderr).toContain("./setup");
      expect(result.stdout).not.toContain("zstack setup complete.");
      expect(after).toEqual(before);
    },
    SPAWN_TIMEOUT_MS
  );
});

describe("AC4 -- git pull --ff-only fails: stops before setup, surfaces git's error", () => {
  test(
    "diverged local commits: non-zero exit, git's fast-forward error shown, pre-existing registration untouched",
    async () => {
      const { srcDir, result, before, after } = await scenario4;
      expect(result.code).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain("fast-forward");
      expect(result.stdout).not.toContain("zstack setup complete.");
      // The failed pull didn't touch the working tree's local commit.
      expect(readFileSync(join(srcDir, "VERSION"), "utf8").trim()).toBe("0.1.0-local");
      expect(after).toBe(before);
    },
    SPAWN_TIMEOUT_MS
  );
});

// Extracts the "source: <path>" line's value a marker file carries.
function markerSource(markerPath: string): string {
  const content = readFileSync(markerPath, "utf8");
  const line = content.split("\n").find((l) => l.startsWith("source: "));
  if (!line) throw new Error(`no "source:" line in ${markerPath}: ${content}`);
  return line.slice("source: ".length);
}

// Bash resolves absolute paths through its OWN mount table (e.g. Windows TEMP
// can alias to /tmp), so a marker's recorded path can legitimately differ
// from a hand-rolled JS drive-letter conversion of the same directory. The
// real correctness bar -- and what bin/z-update's own resolve_source relies
// on -- is that BASH can follow the recorded path back to the real pack, so
// verify that directly instead of string-matching a re-derived POSIX form.
function bashPathHasFile(posixPath: string, relFile: string): boolean {
  const proc = Bun.spawnSync([BASH!, "-c", 'test -e "$1/$2"', "bash", posixPath, relFile]);
  return proc.exitCode === 0;
}

describe("AC5 -- setup's copy-path marker records the clone's absolute path", () => {
  test.skipIf(process.platform !== "win32")(
    "each marker created on the Windows copy path resolves back to the source clone",
    async () => {
      const { env, run } = await scenario5;
      expect(run.code).toBe(0);
      const packSrc = markerSource(join(env.skills, "zstack", ".zstack-registered"));
      expect(packSrc.startsWith("/")).toBe(true); // absolute POSIX path, not empty/relative
      expect(bashPathHasFile(packSrc, "setup")).toBe(true);
      // Per-skill copies get the same treatment.
      const skillSrc = markerSource(join(env.skills, "z-alpha", ".zstack-registered"));
      expect(bashPathHasFile(skillSrc, "setup")).toBe(true);
    },
    SPAWN_TIMEOUT_MS
  );
});
