// Gate tests for ticket #37: the `uninstall` script, driven through real bash
// with HOME pointed at a throwaway fixture dir -- like tests/scaffold.test.ts,
// no test ever touches the real ~/.claude, ~/.zstack, or settings.json. The
// ownership rule (symlink or .zstack-registered sentinel = ours; anything else
// left untouched) is exercised end to end. Deterministic, no network, under the
// 2s-per-file gate budget (each spawn carries the generous timeout scaffold uses
// for Windows spawn contention).
import { test, expect, describe, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const UNINSTALL_PATH = join(REPO_ROOT, "uninstall");

const BASH = Bun.which("bash");
if (!BASH) throw new Error("bash not found on PATH: required to exercise the uninstall script");

// Same POSIX-path shim scaffold.test.ts uses: bash's PATH lookups want /c/... form.
function toPosixPath(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return winPath.replace(/\\/g, "/");
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}
function binDir(name: string): string {
  const resolved = Bun.which(name);
  if (!resolved) throw new Error(`${name} not found on PATH: required to build test fixtures`);
  return toPosixPath(dirname(resolved));
}
const CORE_DIR = binDir("uname"); // coreutils: rm, cp, dirname, mkdir on the fixture PATH

const SPAWN_TIMEOUT_MS = 20000;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "zstack-uninstall-"));
  tmpDirs.push(dir);
  return dir;
}

// A directory registration WE own: a copy carrying the ownership sentinel.
function sentinelCopy(skillsDir: string, name: string): string {
  const path = join(skillsDir, name);
  mkdirSync(join(path, name), { recursive: true }); // a dummy nested skill dir
  writeFileSync(join(path, name, "SKILL.md"), "# fixture\n");
  writeFileSync(join(path, ".zstack-registered"), "Created by zstack ./setup.\n");
  return path;
}

// A same-named directory we did NOT create: no symlink, no sentinel.
function foreignDir(skillsDir: string, name: string): string {
  const path = join(skillsDir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "keep-me.txt"), "user's own dir\n");
  return path;
}

// Can this platform create symlinks without elevation? (Windows without
// Developer Mode throws EPERM.) Gates the symlink-ownership assertion.
function canSymlink(): boolean {
  const probe = makeHome();
  try {
    writeFileSync(join(probe, "target"), "x");
    symlinkSync(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  }
}
const CAN_SYMLINK = canSymlink();

function runUninstall(opts: { home: string; uninstallPath?: string; args?: string[] }) {
  const env: Record<string, string> = { PATH: CORE_DIR, HOME: opts.home };
  for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  const proc = Bun.spawnSync([BASH!, opts.uninstallPath ?? UNINSTALL_PATH, ...(opts.args ?? [])], { env });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// -- AC1: owned entries removed, an un-owned same-named dir left, exit 0 -----
describe("AC1 — ownership: owned entries removed, un-owned left untouched", () => {
  test("sentinel copies removed; a same-named dir without the sentinel is left, named", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const zstack = sentinelCopy(skills, "zstack"); // pack copy, ours
    const zsetup = sentinelCopy(skills, "z-setup"); // a per-skill copy, ours
    const foreign = foreignDir(skills, "z-plan"); // NOT ours

    const result = runUninstall({ home });
    expect(result.exitCode).toBe(0);
    // Owned entries gone.
    expect(existsSync(zstack)).toBe(false);
    expect(existsSync(zsetup)).toBe(false);
    // Un-owned dir left in place, and named in the output.
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(foreign, "keep-me.txt"))).toBe(true);
    expect(result.stdout).toContain("z-plan");
    expect(result.stdout).toContain("not created by zstack");
  }, SPAWN_TIMEOUT_MS);

  test.skipIf(!CAN_SYMLINK)("a symlink registration is recognized as ours and removed", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    // A symlink named z-loop -> some target dir. Removing the link must not
    // delete the target (proof: the target survives).
    const target = join(home, "some-pack");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "VERSION"), "0.1.0\n");
    const link = join(skills, "z-loop");
    symlinkSync(target, link);

    const result = runUninstall({ home });
    expect(result.exitCode).toBe(0);
    expect(existsSync(link)).toBe(false); // link gone
    expect(existsSync(join(target, "VERSION"))).toBe(true); // target untouched
    expect(result.stdout).toContain("symlink");
  }, SPAWN_TIMEOUT_MS);
});

// -- AC2: the pack IS the clone at ~/.claude/skills/zstack -------------------
describe("AC2 — the pack cloned directly at the skills dir is left, rm -rf printed", () => {
  test("clone left in place; per-skill entry removed; exact removal command printed", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    // The clone: ~/.claude/skills/zstack IS the running pack. Copy the real
    // uninstall script into it so PACK_DIR resolves to this location.
    const clone = join(skills, "zstack");
    mkdirSync(clone, { recursive: true });
    cpSync(UNINSTALL_PATH, join(clone, "uninstall"));
    writeFileSync(join(clone, "VERSION"), "0.1.0\n"); // no sentinel: it's a clone
    // A separately-registered per-skill entry that IS ours (must be removed).
    const zsetup = sentinelCopy(skills, "z-setup");

    const result = runUninstall({ home, uninstallPath: join(clone, "uninstall") });
    expect(result.exitCode).toBe(0);
    // The clone is left in place -- it may be the only copy.
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(join(clone, "uninstall"))).toBe(true);
    // The per-skill entry we own is removed.
    expect(existsSync(zsetup)).toBe(false);
    // The output leaves the clone AND prints the exact rm -rf command for it.
    expect(result.stdout).toContain("clone itself");
    expect(result.stdout).toContain("rm -rf");
  }, SPAWN_TIMEOUT_MS);
});

// -- AC3: --purge governs ~/.zstack ------------------------------------------
describe("AC3 — ~/.zstack removed only under --purge", () => {
  function seedZstack(home: string) {
    const dir = join(home, ".zstack", "projects", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}\n");
    // Also seed a host entry so the run has something to report.
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    sentinelCopy(skills, "zstack");
  }

  test("without --purge: ~/.zstack is left, its path and the purge command printed", () => {
    const home = makeHome();
    seedZstack(home);
    const result = runUninstall({ home });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ".zstack"))).toBe(true); // untouched
    expect(result.stdout).toContain(".zstack");
    expect(result.stdout).toContain("--purge");
  }, SPAWN_TIMEOUT_MS);

  test("with --purge: ~/.zstack is removed", () => {
    const home = makeHome();
    seedZstack(home);
    const result = runUninstall({ home, args: ["--purge"] });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ".zstack"))).toBe(false); // gone
    expect(result.stdout).toContain("purged");
  }, SPAWN_TIMEOUT_MS);
});

// -- AC5: a second run is a clean no-op --------------------------------------
describe("AC5 — running twice: the second run removes nothing, exit 0", () => {
  test("first run removes the install; second run reports nothing to remove", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const zstack = sentinelCopy(skills, "zstack");

    const first = runUninstall({ home });
    expect(first.exitCode).toBe(0);
    expect(existsSync(zstack)).toBe(false);

    const second = runUninstall({ home });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Nothing to remove");
  }, SPAWN_TIMEOUT_MS);
});

// -- argument handling -------------------------------------------------------
describe("uninstall argument handling", () => {
  test("an unknown argument exits non-zero, naming it", () => {
    const home = makeHome();
    const result = runUninstall({ home, args: ["--wat"] });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  }, SPAWN_TIMEOUT_MS);

  test("--help prints usage and exits 0", () => {
    const home = makeHome();
    const result = runUninstall({ home, args: ["--help"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: uninstall");
  }, SPAWN_TIMEOUT_MS);

  test("an empty environment (no host dirs, no ~/.zstack): clean no-op", () => {
    const home = makeHome();
    const result = runUninstall({ home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to remove");
  }, SPAWN_TIMEOUT_MS);
});
