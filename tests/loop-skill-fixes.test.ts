// Doc-canary gates for the SKILL-level loop fixes in issue #14 (C3/H9/H13/H17/M22).
// These fixes live in z-loop/SKILL.md and z-plan/SKILL.md (the orchestrator can
// only execute what the SKILL tells it), so the gate scans the real skill files
// and would fail if a fix silently regressed. The one lib contract a skill fix
// leans on -- resolveSlug honoring ZSTACK_SLUG (H13) -- is asserted directly.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSlug } from "../lib/config.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const zLoop = () => readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
const zPlan = () => readFileSync(join(REPO_ROOT, "z-plan", "SKILL.md"), "utf8");

// Returns the body of a "## <heading>" section up to the next "## " heading.
function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start < 0) return "";
  const rest = md.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

// ============================================================================
// C3 -- wave reconciliation is reachable: the drain loop re-ingests every tick
// ============================================================================
describe("C3: drain loop re-reads the board before every next", () => {
  test("Step 4 re-runs list+ingest before asking next (not only Step 3)", () => {
    const step4 = section(zLoop(), "## Step 4 — The drain loop");
    expect(step4).not.toBe("");
    expect(step4).toContain('lib/loop.ts" ingest "$STATE"'); // ingest is now inside the drain loop
    expect(step4).toMatch(/before every/i); // re-read happens before every next
    // The ingest must be positioned before the `next` call in the section.
    expect(step4.indexOf('ingest "$STATE"')).toBeLessThan(step4.indexOf('next "$STATE"'));
  });
});

// ============================================================================
// H9 -- dead merge worker: verify PR state before skipping
// ============================================================================
describe("H9: a dead merge lane is verified via gh pr view, not blind-skipped", () => {
  test("the SKILL documents the gh pr view check for merge lanes", () => {
    const md = zLoop();
    expect(md).toMatch(/gh pr view/);
    expect(md).toMatch(/merge/i);
    expect(md).toMatch(/mergedThisRun/); // the reason: a landed merge must be counted
  });
});

// ============================================================================
// H13 -- --slug never omitted: ZSTACK_SLUG exported once, resolveSlug honors it
// ============================================================================
describe("H13: ZSTACK_SLUG exported in both skills; resolveSlug honors it", () => {
  test("z-loop and z-plan both export ZSTACK_SLUG in setup", () => {
    expect(zLoop()).toContain('export ZSTACK_SLUG="$SLUG"');
    expect(zPlan()).toContain('export ZSTACK_SLUG="$SLUG"');
  });

  test("resolveSlug returns ZSTACK_SLUG when no explicit slug is passed (explicit still wins)", () => {
    const prev = process.env.ZSTACK_SLUG;
    try {
      process.env.ZSTACK_SLUG = "env-proj";
      // home points nowhere: without ZSTACK_SLUG this would throw "No zstack project".
      expect(resolveSlug(undefined, join(REPO_ROOT, "no-such-home"))).toBe("env-proj");
      expect(resolveSlug("explicit", join(REPO_ROOT, "no-such-home"))).toBe("explicit");
    } finally {
      if (prev === undefined) delete process.env.ZSTACK_SLUG;
      else process.env.ZSTACK_SLUG = prev;
    }
  });
});

// ============================================================================
// H17 -- loop counter is peeked mid-loop and bumped only after the report
// ============================================================================
describe("H17: counter peek at start, bump after the report", () => {
  test("Step 7a peeks (no write) up front and bumps last", () => {
    const md = zLoop();
    expect(md).toContain("counter peek"); // sizing the plan without persisting
    expect(md).toContain("counter bump"); // persisted at the end
    // The peek must come before the bump in the document.
    expect(md.indexOf("counter peek")).toBeLessThan(md.indexOf("counter bump"));
  });
});

// ============================================================================
// M22 -- red-path bug filing moves the NEW bug, not the drained ticket
// ============================================================================
describe("M22: red-path parses the created bug number", () => {
  test("the created number is parsed and moved; no bare `move <N> Backlog` placeholder", () => {
    const md = zLoop();
    expect(md).toContain("BUG_N=${NEW%% *}"); // parse the created issue number
    expect(md).toContain('"$Z_BOARD" move "$BUG_N" Backlog'); // move THAT bug
    expect(md).not.toContain('"$Z_BOARD" move <N> Backlog'); // the ambiguous placeholder is gone
  });
});
