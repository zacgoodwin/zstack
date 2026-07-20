// Gate test for bin/z-loop-tick (ticket #57, Leak 2, AC4): the per-iteration
// drain wrapper must print EXACTLY one valid Action JSON line and leave the same
// state file the old three-step snapshot -> ingest -> next sequence produced.
//
// z-board is stubbed via the $Z_BOARD seam (the loop preamble exports it; here it
// points at a fake that emits a fixed board). That is the portable stand-in for
// dropping a stub z-board on PATH -- git-bash on Windows cannot reliably resolve
// a colon-joined PATH from a bun-spawned process, and $Z_BOARD is the same seam
// the real loop already uses. The wrapper runs the REAL lib/loop.ts (its
// $PACK resolves to this repo), so ingest + next are the production code paths.
import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const Z_LOOP_TICK = join(REPO_ROOT, "bin", "z-loop-tick");

// The board the stubbed `z-board snapshot` emits: one Ready ticket, no deps.
const ITEMS = JSON.stringify([
  { number: 1, title: "T1", url: "http://x/1", fields: { Status: "Ready" } },
]);
const BODIES = JSON.stringify({ "1": "no deps" });

const dirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "z-loop-tick-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A fake z-board that only implements `snapshot`, writing the fixed board to the
// --out-items / --out-bodies paths (exactly what the real snapshot does).
function writeStubZBoard(dir: string): string {
  const stub = join(dir, "z-board");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -e
cmd="$1"; shift || true
OUT_ITEMS=""; OUT_BODIES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out-items) OUT_ITEMS="$2"; shift 2 ;;
    --out-bodies) OUT_BODIES="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$cmd" = "snapshot" ]; then
  printf '%s' ${JSON.stringify(ITEMS)} > "$OUT_ITEMS"
  printf '%s' ${JSON.stringify(BODIES)} > "$OUT_BODIES"
  echo "stub snapshot ok"   # discarded by z-loop-tick's >/dev/null
fi
`
  );
  chmodSync(stub, 0o755);
  return stub;
}

describe("z-loop-tick", () => {
  test("prints exactly one Action JSON line and writes the same state the 3-step sequence produces", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp],
      { env: { ...process.env, Z_BOARD: stub }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    // stdout is EXACTLY one non-empty line: the Action JSON (snapshot + ingest
    // are silenced inside the wrapper).
    const lines = proc.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    const action = JSON.parse(lines[0]);
    expect(action).toEqual({ kind: "claim", ticket: 1, stage: "builder" });

    // The state file z-loop-tick wrote equals what the manual sequence produces:
    // the only step that writes state is `ingest`, so run it directly on the same
    // fixture and compare byte-for-byte.
    const items = join(dir, "items.json");
    const bodies = join(dir, "bodies.json");
    const expectedState = join(dir, "expected-state.json");
    writeFileSync(items, ITEMS);
    writeFileSync(bodies, BODIES);
    const ing = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", expectedState, items, bodies],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(ing.exitCode).toBe(0);
    expect(readFileSync(tickState, "utf8")).toBe(readFileSync(expectedState, "utf8"));
  });

  test("missing a required flag fails loudly, prints no Action", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--tmp", join(dir, "t")], // no --state
      { env: { ...process.env, Z_BOARD: stub }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stdout.toString().trim()).toBe("");
    expect(proc.stderr.toString()).toContain("usage: z-loop-tick");
  });
});
