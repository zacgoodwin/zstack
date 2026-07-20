// Functional tests for ticket #85: exclude lockfiles from the adversarial reviewer diff.
// These tests verify that the git pathspec exclusions work correctly.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASH = Bun.which("bash");
if (!BASH) throw new Error("bash not found on PATH: required for git tests");

interface TempRepo {
  path: string;
  cleanup: () => void;
}

function makeTempRepo(): TempRepo {
  const path = mkdtempSync(join(tmpdir(), "reviewer-diff-"));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout;
}

describe("Ticket #85: reviewer diff excludes lockfiles", () => {
  // AC 2: In a temp git repo where a branch changes src/a.ts and bun.lock,
  // the documented command produces a diff containing the src/a.ts hunk and no bun.lock hunk.
  test("AC 2: filtered diff excludes bun.lock but includes src/a.ts", async () => {
    const repo = makeTempRepo();
    try {
      // Initialize repo with a base commit
      await runGit(repo.path, ["init"]);
      await runGit(repo.path, ["config", "user.email", "test@example.com"]);
      await runGit(repo.path, ["config", "user.name", "Test User"]);

      // Create base commit with src/a.ts
      mkdirSync(join(repo.path, "src"), { recursive: true });
      writeFileSync(join(repo.path, "src/a.ts"), "console.log('a');\n");
      writeFileSync(join(repo.path, "bun.lock"), "lock file content\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "base"]);
      const baseSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Create a branch that modifies both src/a.ts and bun.lock
      await runGit(repo.path, ["checkout", "-b", "feature"]);
      writeFileSync(join(repo.path, "src/a.ts"), "console.log('a modified');\n");
      writeFileSync(join(repo.path, "bun.lock"), "lock file content changed\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "modify"]);
      const headSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Run the exact documented filtered diff command
      const filteredDiff = await runGit(repo.path, [
        "diff",
        `${baseSha}...${headSha}`,
        "--",
        ".",
        ":(exclude)*.lock",
        ":(exclude)package-lock.json",
        ":(exclude)pnpm-lock.yaml",
        ":(exclude)yarn.lock",
      ]);

      // Assert src/a.ts is in the diff
      expect(filteredDiff).toContain("src/a.ts");
      expect(filteredDiff).toContain("console.log('a modified')");

      // Assert bun.lock is NOT in the diff
      expect(filteredDiff).not.toContain("bun.lock");
      expect(filteredDiff).not.toContain("lock file content changed");
    } finally {
      repo.cleanup();
    }
  });

  // AC 3 (functional part): In a temp git repo where a branch changes only bun.lock,
  // the documented filtered command produces an empty diff.
  test("AC 3: filtered diff is empty for lockfile-only changes", async () => {
    const repo = makeTempRepo();
    try {
      // Initialize repo
      await runGit(repo.path, ["init"]);
      await runGit(repo.path, ["config", "user.email", "test@example.com"]);
      await runGit(repo.path, ["config", "user.name", "Test User"]);

      // Create base commit with only bun.lock
      writeFileSync(join(repo.path, "bun.lock"), "lock file content\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "base"]);
      const baseSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Create a branch that only modifies bun.lock
      await runGit(repo.path, ["checkout", "-b", "feature"]);
      writeFileSync(join(repo.path, "bun.lock"), "lock file content changed\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "modify"]);
      const headSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Run the exact documented filtered diff command
      const filteredDiff = await runGit(repo.path, [
        "diff",
        `${baseSha}...${headSha}`,
        "--",
        ".",
        ":(exclude)*.lock",
        ":(exclude)package-lock.json",
        ":(exclude)pnpm-lock.yaml",
        ":(exclude)yarn.lock",
      ]);

      // Assert the filtered diff is empty (no changes in non-lockfile paths)
      expect(filteredDiff.trim()).toBe("");
    } finally {
      repo.cleanup();
    }
  });

  // AC 3 (fallback part): verify that falling back to unfiltered diff produces output
  test("AC 3: fallback to unfiltered diff works when filtered is empty", async () => {
    const repo = makeTempRepo();
    try {
      // Initialize repo
      await runGit(repo.path, ["init"]);
      await runGit(repo.path, ["config", "user.email", "test@example.com"]);
      await runGit(repo.path, ["config", "user.name", "Test User"]);

      // Create base commit
      writeFileSync(join(repo.path, "bun.lock"), "lock file content\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "base"]);
      const baseSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Create a branch that only modifies bun.lock
      await runGit(repo.path, ["checkout", "-b", "feature"]);
      writeFileSync(join(repo.path, "bun.lock"), "lock file content changed\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "modify"]);
      const headSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Run filtered diff first
      const filteredDiff = await runGit(repo.path, [
        "diff",
        `${baseSha}...${headSha}`,
        "--",
        ".",
        ":(exclude)*.lock",
        ":(exclude)package-lock.json",
        ":(exclude)pnpm-lock.yaml",
        ":(exclude)yarn.lock",
      ]);

      // Verify it's empty
      expect(filteredDiff.trim()).toBe("");

      // Run unfiltered diff as fallback
      const unfilteredDiff = await runGit(repo.path, [
        "diff",
        `${baseSha}...${headSha}`,
      ]);

      // Verify fallback produces content
      expect(unfilteredDiff.length).toBeGreaterThan(0);
      expect(unfilteredDiff).toContain("bun.lock");
    } finally {
      repo.cleanup();
    }
  });

  // Verify all four pathspec patterns work together
  test("all four pathspecs together exclude all common lockfiles", async () => {
    const repo = makeTempRepo();
    try {
      // Initialize repo
      await runGit(repo.path, ["init"]);
      await runGit(repo.path, ["config", "user.email", "test@example.com"]);
      await runGit(repo.path, ["config", "user.name", "Test User"]);

      // Create base with various lockfiles
      mkdirSync(join(repo.path, "src"), { recursive: true });
      writeFileSync(join(repo.path, "bun.lock"), "bun lock\n");
      writeFileSync(join(repo.path, "package-lock.json"), "npm lock\n");
      writeFileSync(join(repo.path, "pnpm-lock.yaml"), "pnpm lock\n");
      writeFileSync(join(repo.path, "yarn.lock"), "yarn lock\n");
      writeFileSync(join(repo.path, "Cargo.lock"), "cargo lock\n");
      writeFileSync(join(repo.path, "src/main.ts"), "code\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "base"]);
      const baseSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Modify all files
      await runGit(repo.path, ["checkout", "-b", "feature"]);
      writeFileSync(join(repo.path, "bun.lock"), "bun lock changed\n");
      writeFileSync(join(repo.path, "package-lock.json"), "npm lock changed\n");
      writeFileSync(join(repo.path, "pnpm-lock.yaml"), "pnpm lock changed\n");
      writeFileSync(join(repo.path, "yarn.lock"), "yarn lock changed\n");
      writeFileSync(join(repo.path, "Cargo.lock"), "cargo lock changed\n");
      writeFileSync(join(repo.path, "src/main.ts"), "code changed\n");
      await runGit(repo.path, ["add", "."]);
      await runGit(repo.path, ["commit", "-m", "modify"]);
      const headSha = (await runGit(repo.path, ["rev-parse", "HEAD"])).trim();

      // Run the filtered diff
      const filteredDiff = await runGit(repo.path, [
        "diff",
        `${baseSha}...${headSha}`,
        "--",
        ".",
        ":(exclude)*.lock",
        ":(exclude)package-lock.json",
        ":(exclude)pnpm-lock.yaml",
        ":(exclude)yarn.lock",
      ]);

      // src/main.ts should be included
      expect(filteredDiff).toContain("src/main.ts");
      expect(filteredDiff).toContain("code changed");

      // All lockfiles should be excluded
      expect(filteredDiff).not.toContain("bun lock");
      expect(filteredDiff).not.toContain("npm lock");
      expect(filteredDiff).not.toContain("pnpm lock");
      expect(filteredDiff).not.toContain("yarn lock");
      expect(filteredDiff).not.toContain("cargo lock");
    } finally {
      repo.cleanup();
    }
  });
});
