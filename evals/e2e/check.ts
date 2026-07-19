#!/usr/bin/env bun
// The e2e eval's programmatic checker. Runs every assertion in assertions.ts
// over a run's artifact directory and exits non-zero if any fail, so it drops
// straight into the paid-lane harness (run.md) as the pass/fail gate. With no
// argument it defaults to the hand-authored sample-run fixture, which is what
// tests/e2e-check.test.ts drives so the checker itself stays gate-testable.
//
// Usage:
//   bun evals/e2e/check.ts [runDir]
//   bun evals/e2e/check.ts ~/.zstack/projects/<slug>       # a live run's dir
import { join } from "node:path";
import { runAllAssertions, type AssertionResult } from "./assertions.ts";

export const SAMPLE_RUN = join(import.meta.dir, "fixtures", "sample-run");

export function formatResults(results: AssertionResult[]): string {
  const lines = results.map((r) => `  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(18)} ${r.detail}`);
  const passed = results.filter((r) => r.pass).length;
  lines.push("");
  lines.push(`  ${passed}/${results.length} assertions passed`);
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const runDir = argv[0] ?? SAMPLE_RUN;
  let results: AssertionResult[];
  try {
    results = runAllAssertions(runDir);
  } catch (e) {
    console.error(`e2e check could not run against ${runDir}: ${(e as Error).message}`);
    return 1;
  }
  console.log(`e2e run check: ${runDir}`);
  console.log(formatResults(results));
  return results.every((r) => r.pass) ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
