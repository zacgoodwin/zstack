// Gate tests for the C1 scaffold: setup's precondition checks (run against
// real bash with PATH/HOME manipulated so deps look present/absent) and the
// docs/user-guide/spec restructure. Deterministic, no network, must stay well
// under the 2s gate budget.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SETUP_PATH = join(REPO_ROOT, "setup");

const BASH = Bun.which("bash");
if (!BASH) throw new Error("bash not found on PATH: required to exercise the setup script");

// Bun.which() returns native Windows paths (C:\...). bash's own PATH lookups
// need POSIX form (/c/...), since ':' both separates PATH entries and follows
// a Windows drive letter, so mixing the two forms breaks parsing.
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

const BUN_DIR = binDir("bun");
// gh may legitimately be absent on a dev machine (issue #14 item 18). binDir()
// would throw at module load and fail the WHOLE file; instead the tests that
// need gh on the fixture PATH carry a skipIf(!GH_DIR) guard and skip cleanly.
// bun and coreutils stay hard preconditions: without them nothing here runs.
const GH_PATH = Bun.which("gh");
const GH_DIR = GH_PATH ? toPosixPath(dirname(GH_PATH)) : null;
const CORE_DIR = binDir("uname"); // /usr/bin on Windows: uname, mkdir, cp, rm

const tmpHomes: string[] = [];
function makeTmpHome(withGstack: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "zstack-setup-test-"));
  tmpHomes.push(dir);
  if (withGstack) {
    mkdirSync(join(dir, ".claude", "skills", "gstack"), { recursive: true });
  }
  return dir;
}

afterEach(() => {
  while (tmpHomes.length) {
    rmSync(tmpHomes.pop()!, { recursive: true, force: true });
  }
});

function runSetup(opts: { path: string; home: string; args?: string[] }) {
  const env: Record<string, string> = { PATH: opts.path, HOME: opts.home };
  // MSYS's bash.exe wants these for its own runtime init; harmless passthrough.
  for (const key of ["SYSTEMROOT", "windir", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  const proc = Bun.spawnSync([BASH!, SETUP_PATH, ...(opts.args ?? [])], { env });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// Each test here spawns a real bash process running the setup script (no
// mocking the shell out). 5000ms (bun's default) is comfortably clear in
// isolation but was observed exceeded under full-suite parallel load on
// Windows (issue #23) -- process spawn/teardown contends with every other
// file's spawns. 20000ms keeps a genuine hang failing loud while absorbing
// that contention; the test logic and what it asserts are unchanged.
const SPAWN_TIMEOUT_MS = 20000;

describe("setup preconditions", () => {
  test("bun missing: exits non-zero pointing to bun.sh", () => {
    const home = makeTmpHome(false);
    const result = runSetup({ path: CORE_DIR, home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bun is required");
  }, SPAWN_TIMEOUT_MS);

  test("gstack missing: exits non-zero printing the exact gstack install command", () => {
    const home = makeTmpHome(false);
    const result = runSetup({ path: `${BUN_DIR}:${CORE_DIR}`, home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "gstack is required but not installed at ~/.claude/skills/gstack"
    );
    expect(result.stderr).toContain(
      "git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack"
    );
    expect(result.stderr).toContain("cd ~/.claude/skills/gstack && ./setup --team");
  }, SPAWN_TIMEOUT_MS);

  test("gh missing: exits non-zero", () => {
    const home = makeTmpHome(true);
    const result = runSetup({ path: `${BUN_DIR}:${CORE_DIR}`, home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gh (GitHub CLI) is required");
  }, SPAWN_TIMEOUT_MS);

  test.skipIf(!GH_DIR)("all deps present: registers the pack dir without error", () => {
    const home = makeTmpHome(true);
    const result = runSetup({ path: `${BUN_DIR}:${GH_DIR}:${CORE_DIR}`, home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("zstack setup complete.");

    const registered = join(home, ".claude", "skills", "zstack");
    expect(existsSync(registered)).toBe(true);
    expect(readFileSync(join(registered, "VERSION"), "utf8").trim()).toBe(
      readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim()
    ); // the registered copy matches the repo VERSION (whatever the parent bumped it to)
    // The Windows copy filters repo baggage — without this the copy hauls
    // ~75MB of node_modules/.git/.worktrees and this test blows its timeout.
    // (On macOS/Linux registration is a symlink to the repo, so the paths
    // exist through it by design — the filter only applies to copies.)
    if (process.platform === "win32") {
      expect(existsSync(join(registered, "node_modules"))).toBe(false);
      expect(existsSync(join(registered, ".git"))).toBe(false);
    }
  }, SPAWN_TIMEOUT_MS);

  // Ticket #37: uninstall proves ownership before deleting a registration. A
  // symlink is self-evidently ours; a COPY (the Windows install path) needs the
  // .zstack-registered sentinel setup drops into it. Without this marker a real
  // Windows install would be indistinguishable from a user's own dir and
  // uninstall would refuse to remove it -- so setup must write it.
  test.skipIf(!GH_DIR)("registration is provably ours: sentinel on a copy, symlink otherwise", () => {
    const home = makeTmpHome(true);
    const result = runSetup({ path: `${BUN_DIR}:${GH_DIR}:${CORE_DIR}`, home });
    expect(result.exitCode).toBe(0);
    const registered = join(home, ".claude", "skills", "zstack");
    const st = lstatSync(registered);
    if (st.isSymbolicLink()) {
      // POSIX path: the symlink is the ownership proof; no sentinel needed.
      expect(existsSync(join(registered, ".zstack-registered"))).toBe(false);
    } else {
      // Windows copy path: the sentinel must be present inside the copy.
      expect(existsSync(join(registered, ".zstack-registered"))).toBe(true);
    }
  }, SPAWN_TIMEOUT_MS);

  test.skipIf(!GH_DIR)("--team flag is accepted", () => {
    const home = makeTmpHome(true);
    const result = runSetup({
      path: `${BUN_DIR}:${GH_DIR}:${CORE_DIR}`,
      home,
      args: ["--team"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Team mode requested");
  }, SPAWN_TIMEOUT_MS);
});

describe("docs/user-guide/spec restructure", () => {
  const MOVED_DOCS = [
    "PROCESS.md",
    "ESTIMATION.md",
    "PRINCIPLES.md",
    "ORCHESTRATOR.md",
    "ORCHESTRATOR SAMPLE.md",
    "QA SAMPLE.md",
    "REVIEWER SAMPLE.md",
    "WORKER SAMPLE.md",
    "develop stage.png",
    "merge stage.png",
    "planning Process.png",
  ];

  const SPEC_DIR = join(REPO_ROOT, "docs", "user-guide", "spec");
  for (const doc of MOVED_DOCS) {
    test(`docs/user-guide/spec/${doc} exists`, () => {
      expect(existsSync(join(SPEC_DIR, doc))).toBe(true);
    });

    test(`${doc} is not left in references/ or at repo root`, () => {
      expect(existsSync(join(REPO_ROOT, "references", doc))).toBe(false);
      expect(existsSync(join(REPO_ROOT, doc))).toBe(false);
    });
  }
});

describe("root scaffold", () => {
  test("VERSION uses the 4-segment MAJOR.MINOR.PATCH.MICRO scheme", () => {
    // Pinning a literal version broke on the first release bump; the durable
    // contract is the 4-segment scheme /ship's version-bump tooling parses.
    expect(readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  test("package.json wires bun test", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.test).toContain("bun test");
  });

  test("bunfig.toml scopes test discovery to tests/", () => {
    const bunfig = readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf8");
    expect(bunfig).toMatch(/root\s*=\s*"tests"/);
  });

  test(".gitignore covers .worktrees/ and node_modules/", () => {
    const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain(".worktrees/");
    expect(gitignore).toContain("node_modules/");
  });

  test("README.md exists at root", () => {
    expect(existsSync(join(REPO_ROOT, "README.md"))).toBe(true);
  });
});
