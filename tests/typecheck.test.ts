// Gate: the pack typechecks under its own strict tsconfig (issue #14 item 20).
// The pack demands typecheck gates of the repos it runs against, so it must be
// able to pass its own: this shells the real `bun run typecheck` (tsc --noEmit)
// exactly as a human or the loop's regression stage would. Deterministic and
// local -- tsc against a pinned typescript devDependency, no network.
import { test, expect } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

test(
  "bun run typecheck (tsc --noEmit) is green",
  () => {
    const proc = Bun.spawnSync(["bun", "run", "typecheck"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    // On failure the assertion message carries tsc's own output, so the
    // violation (or a toolchain problem) names itself in the test report.
    expect(proc.exitCode === 0 ? "" : `tsc exited ${proc.exitCode}:\n${out}`).toBe("");
  },
  // tsc is the one gate allowed past the 2s budget: a compiler start is not
  // flaky, just slower than a unit test. Generous ceiling so CI never times out.
  120_000
);
