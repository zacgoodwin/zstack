// Gate tests for ticket #37: the `uninstall` script, driven through real bash
// with HOME pointed at a throwaway fixture dir -- like tests/scaffold.test.ts,
// no test ever touches the real ~/.claude, ~/.zstack, or settings.json. The
// ownership rule (symlink or .zstack-registered sentinel = ours; anything else
// left untouched) is exercised end to end. Deterministic, no network, under the
// 2s-per-file gate budget (each spawn carries the generous timeout scaffold uses
// for Windows spawn contention).
import { test, expect, describe, afterEach } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const UNINSTALL_PATH = join(REPO_ROOT, "uninstall");
const SKILL_PATH = join(REPO_ROOT, "z-uninstall", "SKILL.md");

// Extract the FIRST ```bash fenced block from SKILL.md — the pack-resolution
// snippet the skill prescribes before Step 2. AC2 runs THIS snippet (not a copy
// of it) so a regression in the skill's own resolution trips the gate. Normalize
// CRLF first: the repo checks out .md with CRLF on Windows, and stray \r in a
// `bash -c` body breaks command parsing.
function firstBashBlock(md: string): string {
  const m = md.replace(/\r\n/g, "\n").match(/```bash\n([\s\S]*?)```/);
  if (!m) throw new Error("no ```bash block found in SKILL.md");
  return m[1];
}

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

  // #49 AC1: a symlink counts as ours ONLY when its target resolves INTO the pack
  // (setup only ever links to PACK_DIR or a skill dir within it).
  test.skipIf(!CAN_SYMLINK)("a symlink INTO the pack is recognized as ours and removed; its target is untouched", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    // The macOS/Linux install: z-loop -> <pack>/z-loop. readlink -f lands inside
    // PACK_DIR (the repo root here), so it's ours. Removing the link must not
    // delete the target (proof: the real skill dir survives).
    const target = join(REPO_ROOT, "z-loop"); // a real skill dir inside the pack
    const link = join(skills, "z-loop");
    symlinkSync(target, link);

    const result = runUninstall({ home });
    expect(result.exitCode).toBe(0);
    expect(existsSync(link)).toBe(false); // link gone
    expect(existsSync(join(target, "SKILL.md"))).toBe(true); // target untouched
    expect(result.stdout).toContain("symlink into the pack");
  }, SPAWN_TIMEOUT_MS);

  // #49 AC1: a same-named symlink pointing OUTSIDE the pack is a user's own link,
  // NOT ours -- deletion-safety demands it be left, never removed.
  test.skipIf(!CAN_SYMLINK)("a foreign symlink pointing OUTSIDE the pack is left and named; its target is untouched", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    // A user's OWN skill named z-loop, symlinked from outside the pack.
    const theirs = join(home, "their-skills", "z-loop");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "SKILL.md"), "---\nname: z-loop\n---\ntheirs\n");
    const link = join(skills, "z-loop");
    symlinkSync(theirs, link);

    const result = runUninstall({ home });
    expect(result.exitCode).toBe(0);
    expect(existsSync(link)).toBe(true); // link LEFT in place
    expect(existsSync(join(theirs, "SKILL.md"))).toBe(true); // target untouched
    expect(result.stdout).toContain("z-loop");
    expect(result.stdout).toContain("outside the zstack pack");
  }, SPAWN_TIMEOUT_MS);
});

// -- #49 AC2: a symlinked pack -- the sequence keeps its bin after uninstall -----
describe("#49 AC2 — symlinked pack: /z-uninstall keeps bin/z-setup-permissions reachable after Step 2", () => {
  test.skipIf(!CAN_SYMLINK)("PACK resolves to the physical clone up front, so Step 3's tool survives the symlink removal", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    // A real clone elsewhere, carrying bin/ and the real uninstall script.
    const clone = join(home, "zstack-clone");
    mkdirSync(join(clone, "bin"), { recursive: true });
    cpSync(UNINSTALL_PATH, join(clone, "uninstall"));
    writeFileSync(join(clone, "bin", "z-setup-permissions"), "#!/usr/bin/env bash\necho ok\n");
    // The canonical macOS/Linux install: the pack entry is a symlink into the clone.
    symlinkSync(clone, join(skills, "zstack"));

    // Run the skill's OWN resolution snippet, then Step 2 (uninstall), then probe
    // for Step 3's tool via $PACK and via the naive link-relative path.
    const script = [
      firstBashBlock(readFileSync(SKILL_PATH, "utf8")),
      `"$PACK/uninstall" >/dev/null 2>&1`,
      `test -e "$PACK/bin/z-setup-permissions" && echo BIN_FOUND || echo BIN_MISSING`,
      `test -e "$HOME/.claude/skills/zstack" && echo LINK_PRESENT || echo LINK_GONE`,
    ].join("\n");
    const env: Record<string, string> = { PATH: CORE_DIR, HOME: home };
    for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
      const v = process.env[key];
      if (v) env[key] = v;
    }
    const proc = Bun.spawnSync([BASH!, "-c", script], { env });
    const out = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    // Step 2 really removed the symlinked registration (so the naive path is dead)...
    expect(out).toContain("LINK_GONE");
    // ...yet $PACK, bound to the physical clone before Step 2, still reaches the tool.
    expect(out).toContain("BIN_FOUND");
    expect(out).not.toContain("BIN_MISSING");
  }, SPAWN_TIMEOUT_MS);
});

// -- #49 AC3: a registered COPY running its own uninstall names itself honestly --
describe("#49 AC3 — a sentinel COPY running its own uninstall is a 'registered copy', not 'the clone'", () => {
  test("the running copy is left and named a registered copy with rm -rf; separate owned entries still removed", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    // The Windows install: ~/.claude/skills/zstack is a sentinel-carrying COPY,
    // and we run THAT copy's own uninstall (so PACK_DIR == the copy).
    const copy = join(skills, "zstack");
    mkdirSync(copy, { recursive: true });
    cpSync(UNINSTALL_PATH, join(copy, "uninstall"));
    writeFileSync(join(copy, ".zstack-registered"), "Created by zstack ./setup.\n");
    // A separately-registered per-skill copy that IS ours (and is NOT the running dir).
    const zsetup = sentinelCopy(skills, "z-setup");

    const result = runUninstall({ home, uninstallPath: join(copy, "uninstall") });
    expect(result.exitCode).toBe(0);
    // The running copy is left (we cannot delete the dir we're executing from)...
    expect(existsSync(copy)).toBe(true);
    // ...named honestly as a registered copy, NOT "the clone itself"...
    expect(result.stdout).toContain("registered copy");
    expect(result.stdout).not.toContain("clone itself");
    // ...with the exact manual removal command.
    expect(result.stdout).toContain("rm -rf");
    // The separately-registered entry we own is still removed.
    expect(existsSync(zsetup)).toBe(false);
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

// -- AC5 / #49 AC4: a second run's message matches what the docs promise -------
describe("AC5 / #49 AC4 — running twice: the second run's output matches the docs", () => {
  test("symlink/copy install: first run removes it; second run reports nothing to remove", () => {
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

  // #49 AC4: a clone-in-skills install keeps the retained clone every run, so the
  // second run must NOT print "Nothing to remove" -- it reports the clone left,
  // exactly as docs/user-guide/z-uninstall.md ("Running it again") now promises.
  test("clone-in-skills install: second run reports the clone left, not 'Nothing to remove'", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const clone = join(skills, "zstack");
    mkdirSync(clone, { recursive: true });
    cpSync(UNINSTALL_PATH, join(clone, "uninstall"));
    writeFileSync(join(clone, "VERSION"), "0.1.0\n"); // no sentinel: a bare clone

    const first = runUninstall({ home, uninstallPath: join(clone, "uninstall") });
    expect(first.exitCode).toBe(0);
    expect(existsSync(clone)).toBe(true); // deliberately retained

    const second = runUninstall({ home, uninstallPath: join(clone, "uninstall") });
    expect(second.exitCode).toBe(0);
    expect(existsSync(clone)).toBe(true); // still retained
    expect(second.stdout).toContain("clone itself");
    expect(second.stdout).toContain("rm -rf");
    expect(second.stdout).not.toContain("Nothing to remove");
  }, SPAWN_TIMEOUT_MS);

  // #49 AC4 (review bounce): the Windows registered COPY that /z-uninstall runs
  // from is the standard Windows path, not an edge -- it is owned (sentinel) but
  // the running dir cannot self-delete, so uninstall retains it and increments
  // `left` on EVERY run. "Nothing to remove" therefore never prints for it. This
  // pins the second exception docs/user-guide/z-uninstall.md now documents, so the
  // user-guide can no longer drift back to the old "copy install -> Nothing to
  // remove" overstatement without tripping the gate.
  test("registered-copy-in-skills install: second run reports the copy left, not 'Nothing to remove'", () => {
    const home = makeHome();
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const copy = join(skills, "zstack");
    mkdirSync(copy, { recursive: true });
    cpSync(UNINSTALL_PATH, join(copy, "uninstall"));
    writeFileSync(join(copy, ".zstack-registered"), "Created by zstack ./setup.\n"); // sentinel: a registered copy

    const first = runUninstall({ home, uninstallPath: join(copy, "uninstall") });
    expect(first.exitCode).toBe(0);
    expect(existsSync(copy)).toBe(true); // deliberately retained (the running dir)

    const second = runUninstall({ home, uninstallPath: join(copy, "uninstall") });
    expect(second.exitCode).toBe(0);
    expect(existsSync(copy)).toBe(true); // still retained
    expect(second.stdout).toContain("registered copy");
    expect(second.stdout).toContain("rm -rf");
    expect(second.stdout).not.toContain("Nothing to remove");
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
