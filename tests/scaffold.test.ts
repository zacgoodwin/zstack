// Gate tests for the C1 scaffold: setup's precondition checks (run against
// real bash with PATH/HOME manipulated so deps look present/absent) and the
// references/ restructure. Deterministic, no network, must stay well under
// the 2s gate budget.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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

describe("setup preconditions", () => {
  test("bun missing: exits non-zero pointing to bun.sh", () => {
    const home = makeTmpHome(false);
    const result = runSetup({ path: CORE_DIR, home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bun is required");
  });

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
  });

  test("gh missing: exits non-zero", () => {
    const home = makeTmpHome(true);
    const result = runSetup({ path: `${BUN_DIR}:${CORE_DIR}`, home });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gh (GitHub CLI) is required");
  });

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
  });

  test.skipIf(!GH_DIR)("--team flag is accepted", () => {
    const home = makeTmpHome(true);
    const result = runSetup({
      path: `${BUN_DIR}:${GH_DIR}:${CORE_DIR}`,
      home,
      args: ["--team"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Team mode requested");
  });
});

describe("references/ restructure", () => {
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

  for (const doc of MOVED_DOCS) {
    test(`references/${doc} exists`, () => {
      expect(existsSync(join(REPO_ROOT, "references", doc))).toBe(true);
    });

    test(`${doc} is not left at repo root`, () => {
      expect(existsSync(join(REPO_ROOT, doc))).toBe(false);
    });
  }
});

describe("root scaffold", () => {
  test("VERSION starts at 0.1.0", () => {
    // Matches the 0.1.0 line whether or not the parent has appended a release
    // segment (e.g. 0.1.0.0); the point is the pack shipped at the 0.1.0 baseline.
    expect(readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim()).toMatch(/^0\.1\.0(\.\d+)?$/);
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
