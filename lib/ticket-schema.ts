// The ticket-body schema and its validator, plus the kebab-case title slug used
// for idempotent re-plan matching. z-plan (C5) writes ticket bodies to this
// shape and gates every one through validateTicketBody before it hits the board;
// the loop's planning pass (PROCESS.md step 1) reuses the same gate so "all
// mandatory sections present" means the same thing everywhere. Deterministic and
// dependency-free: parsing markdown headings is a regex match, not model work
// (PRINCIPLES.md, latent vs deterministic), so it lives in a script with tests
// and never in a prompt.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { roundCents } from "./estimate.ts";

export type TicketErrorCode = "missing" | "malformed" | "empty" | "bad-path";

export interface TicketError {
  section: string; // the schema section this error is about
  code: TicketErrorCode;
  message: string; // human-readable, names exactly what is wrong
}

export interface TicketValidation {
  ok: boolean;
  errors: TicketError[];
}

// A mandatory section: its canonical heading text and the exact heading level
// the schema pins it to. Acceptance Criteria is an h3 because it is a subsection
// of Plan (PROCESS.md: "The plan MUST contain a `### Acceptance Criteria`
// section"); the rest are top-level h2. Order is not enforced -- presence,
// level, and non-empty content are what the loop actually depends on.
interface SectionSpec {
  title: string; // canonical, as written in the schema
  level: number; // required "#" count
}

export const REQUIRED_SECTIONS: SectionSpec[] = [
  { title: "Context", level: 2 },
  { title: "Plan", level: 2 },
  { title: "Acceptance Criteria", level: 3 },
  { title: "Tests + evals", level: 2 },
  { title: "Docs pages touched", level: 2 },
  { title: "Out of scope", level: 2 },
];

// Exported (issue #25): evals/planner/harness.ts's dry-run output splitter
// reuses this exact fence-aware heading scan to find each ticket's "## Context"
// boundary, instead of duplicating the fence-tracking logic in a second file
// that could drift out of sync with this one.
export interface Heading {
  line: number; // 0-based line index of the heading
  level: number;
  title: string; // trimmed heading text
}

// Normalizes a heading title for matching: lowercase, whitespace runs collapsed
// to one space, trimmed. So "Tests + evals", "Tests  +  Evals", and
// "tests + evals" all match the same section spec.
function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

// Collects real markdown headings in document order, skipping any that fall
// inside a fenced code block. A ticket's `## Plan` routinely embeds a bash fence
// with "# comment" lines and file listings; without fence-awareness those would
// read as headings and wrongly cut a section short or invent a phantom one.
export function parse(md: string): { headings: Heading[]; lines: string[] } {
  const lines = md.split(/\r?\n/);
  const headings: Heading[] = [];
  let fence = ""; // the open fence marker char ("`" or "~"), "" when outside
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const marker = f[1][0];
      if (!fence) fence = marker;
      else if (marker === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) headings.push({ line: i, level: m[1].length, title: m[2].trim() });
  }
  return { headings, lines };
}

// A section has content when at least one non-blank line sits between its
// heading and the next heading of any level (its own direct body). This is why
// `## Plan` immediately followed by `### Acceptance Criteria` reads as an empty
// plan: the AC lines belong to the AC subsection, not to Plan.
function hasContent(headings: Heading[], idx: number, lines: string[]): boolean {
  const start = headings[idx].line + 1;
  const end = headings[idx + 1]?.line ?? lines.length;
  for (let i = start; i < end; i++) {
    if (lines[i].trim() !== "") return true;
  }
  return false;
}

// Optional `## Files` section (issue #84): when present it is the grounding
// map z-plan discovered at plan time, so the builder/QA/reviewer stages stop
// re-discovering the same files with fresh glob/grep. Absent stays valid --
// existing board tickets and hand-filed backlog items keep passing.
const FILES_BULLET = /^- (.*)$/; // top-level bullet only ("- " at column 0); nested/indented bullets and prose are ignored
const BACKTICK_SPAN = /`([^`]+)`/; // first backticked span = the path; later spans are prose

function validateFilesSection(headings: Heading[], lines: string[], repoRoot?: string): TicketError[] {
  const errors: TicketError[] = [];
  const idx = headings.findIndex((h) => normTitle(h.title) === "files");
  if (idx === -1) return errors; // optional section; absent is valid

  const h = headings[idx];
  if (h.level !== 2) {
    errors.push({
      section: "Files",
      code: "malformed",
      message: `Section "Files" must be at heading level 2 (##), found level ${h.level}.`,
    });
    return errors;
  }
  if (!hasContent(headings, idx, lines)) {
    errors.push({
      section: "Files",
      code: "empty",
      message: `Section "Files" is present but has no content before the next heading.`,
    });
    return errors;
  }

  const start = h.line + 1;
  const end = headings[idx + 1]?.line ?? lines.length;
  for (let i = start; i < end; i++) {
    const m = lines[i].match(FILES_BULLET);
    if (!m) continue; // nested bullet or prose line -- not a path entry
    const bullet = m[1];
    const bt = bullet.match(BACKTICK_SPAN);
    if (!bt) {
      errors.push({
        section: "Files",
        code: "malformed",
        message: `Files bullet has no backticked path: ${JSON.stringify(bullet.trim())}.`,
      });
      continue;
    }
    const p = bt[1];
    // Always checked, flag-independent: an absolute path or a ".." segment
    // can never resolve to a safe repo-relative location.
    if (isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
      errors.push({
        section: "Files",
        code: "bad-path",
        message: `Files path "${p}" is not a safe repo-relative path (must not be absolute or contain "..").`,
      });
      continue;
    }
    if (repoRoot && !bullet.trim().endsWith("(new)") && !existsSync(join(repoRoot, p))) {
      errors.push({
        section: "Files",
        code: "missing",
        message: `Files path does not exist under repo root: ${p}`,
      });
    }
  }
  return errors;
}

// Validates a ticket body against the schema. Returns every problem found (not
// just the first) so a planner sees the whole gap in one pass. A `Depends on:`
// line is optional -- a ticket with no dependencies has none -- but if present
// it must name at least one `#N` (or say none/n/a), so an empty stub is caught.
// `repoRoot`, when given, additionally gates every `## Files` path's existence
// (`--check-paths`, bin/z-ticket-lint) -- omit it and only the bad-path check
// (absolute / "..") runs.
export function validateTicketBody(md: string, repoRoot?: string): TicketValidation {
  const { headings, lines } = parse(md);
  const errors: TicketError[] = [];

  for (const spec of REQUIRED_SECTIONS) {
    const want = normTitle(spec.title);
    const idx = headings.findIndex((h) => normTitle(h.title) === want);
    if (idx === -1) {
      errors.push({
        section: spec.title,
        code: "missing",
        message: `Missing mandatory section: a "${"#".repeat(spec.level)} ${spec.title}" heading.`,
      });
      continue;
    }
    const h = headings[idx];
    if (h.level !== spec.level) {
      errors.push({
        section: spec.title,
        code: "malformed",
        message: `Section "${spec.title}" must be at heading level ${spec.level} (${"#".repeat(spec.level)}), found level ${h.level}.`,
      });
      continue;
    }
    if (!hasContent(headings, idx, lines)) {
      errors.push({
        section: spec.title,
        code: "empty",
        message: `Section "${spec.title}" has no content before the next heading.`,
      });
    }
  }

  errors.push(...validateFilesSection(headings, lines, repoRoot));

  // Optional dependency line: only validated when present.
  const dep = lines.find((l) => /^\s*depends on:/i.test(l));
  if (dep !== undefined) {
    const rest = dep.replace(/^\s*depends on:/i, "").trim();
    if (!/#\d+/.test(rest) && !/\b(none|n\/a)\b/i.test(rest)) {
      errors.push({
        section: "Depends on",
        code: "malformed",
        message: `"Depends on:" line names no issue (#N) and is not "none"/"n/a": ${JSON.stringify(dep.trim())}.`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// Kebab-case ASCII slug of a ticket title, used to match an existing ticket on a
// re-plan so z-plan updates instead of duplicating. Stable: the output contains
// only [a-z0-9-] with single hyphens and no leading/trailing hyphen, so
// slugifyTitle(slugifyTitle(x)) === slugifyTitle(x).
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFKD") // split accented letters into base + diacritic
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (U+0300-U+036F) -> ASCII base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any non-alphanumeric run -> one hyphen
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

// The 400K-context chunking gate (PROCESS.md step 3). Deciding whether a ticket
// needs splitting is a comparison on two integers, so it is deterministic space,
// not the planner's head: z-plan counts the distinct files (F) and plan steps (S)
// and calls this. The thresholds are derived from the estimator's bucket sizing
// -- peak context ~= 50K grounding + ~10K per file + ~8K working per step; set
// that over 400K and the operational cutoffs fall out. See z-plan/SKILL.md Step 5.
export const CONTEXT_BUDGET_TOKENS = 400_000;
export const SPLIT_MAX_FILES = 15; // ~50K + 15*10K + slack ~ budget
export const SPLIT_MAX_STEPS = 30; // ~50K + 30*8K + slack ~ budget

export interface SplitDecision {
  split: boolean;
  reason: string;
}

export function needsSplit(fileCount: number, stepCount: number): SplitDecision {
  if (fileCount > SPLIT_MAX_FILES) {
    return { split: true, reason: `${fileCount} files > ${SPLIT_MAX_FILES}; over the ${CONTEXT_BUDGET_TOKENS}-token context budget.` };
  }
  if (stepCount > SPLIT_MAX_STEPS) {
    return { split: true, reason: `${stepCount} steps > ${SPLIT_MAX_STEPS}; over the ${CONTEXT_BUDGET_TOKENS}-token context budget.` };
  }
  // Neither extreme alone, but a broad-and-deep plan still blows the budget.
  if (fileCount > 8 && stepCount > 20) {
    return { split: true, reason: `${fileCount} files and ${stepCount} steps together exceed the ${CONTEXT_BUDGET_TOKENS}-token context budget.` };
  }
  return { split: false, reason: "fits in one context window" };
}

// The cost-based split gate (issue #78), complementing needsSplit's context
// gate: even a plan that fits in one context window can still be cheaper to
// run as several smaller tickets than as one big one, because the Estimate
// tiers (z-plan/SKILL.md Step 6) are not linear in scope. Dollar totals
// mirror the tier table pinned in tests/plan-schema.test.ts (the same
// tier -> z-estimate chain issue #7 AC2 made reproducible); a test there
// cross-checks this table against that chain so a rates.json/tiers.json
// change can't silently desync this pure lookup.
export const TIER_ESTIMATES: Record<string, number> = {
  "haiku-low": 1.86,
  "sonnet-medium": 10.27,
  "opus-high": 9.44,
  "opus-xhigh": 15.77,
  "fable-xhigh": 45.22,
};

function tierEstimate(tier: string): number {
  const dollars = TIER_ESTIMATES[tier];
  if (dollars === undefined) {
    throw new Error(
      `shouldSplitForCost: unknown tier "${tier}". Known tiers: ${Object.keys(TIER_ESTIMATES).join(", ")}.`
    );
  }
  return dollars;
}

// Deciding whether to split is a comparison on two dollar figures, so it is
// deterministic space (PRINCIPLES.md), not the planner's head: z-plan picks
// the tier the single ticket would carry and the tiers a proposed
// decomposition's children would each carry, and calls this. Splits only
// when the children's Estimate sum is STRICTLY below the parent's -- a split
// that costs the same or more just adds review/merge overhead for nothing.
export function shouldSplitForCost(parentTier: string, childTiers: string[]): SplitDecision {
  if (childTiers.length === 0) {
    throw new Error("shouldSplitForCost: childTiers must be non-empty (a split needs at least one child).");
  }
  const parentTotal = tierEstimate(parentTier);
  const childTotal = roundCents(childTiers.reduce((sum, t) => sum + tierEstimate(t), 0));
  const split = childTotal < parentTotal;
  const reason = split
    ? `children total $${childTotal.toFixed(2)} < parent ${parentTier} $${parentTotal.toFixed(2)}; splitting is cheaper.`
    : `children total $${childTotal.toFixed(2)} >= parent ${parentTier} $${parentTotal.toFixed(2)}; splitting does not save money.`;
  return { split, reason };
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `z-ticket-lint <ticket-body.md> [--check-paths <repoRoot>]

  Validates a ticket body file against the ticket schema (lib/ticket-schema.ts).
  Exit 0 = valid; exit 1 = invalid (errors on stderr) or a usage/read error.
  Mandatory sections: ${REQUIRED_SECTIONS.map((s) => `${"#".repeat(s.level)} ${s.title}`).join(", ")}.
  Optional: a "## Files" section listing repo-relative paths, one per
  top-level bullet ("- \`path\` ..."); an absolute path or one containing ".."
  always fails (bad-path). --check-paths <repoRoot> additionally requires every
  Files path to exist under repoRoot (a bullet ending "(new)" is exempt).`;

export function main(argv: string[]): number {
  const rest: string[] = [];
  let repoRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check-paths") {
      repoRoot = argv[++i];
      if (repoRoot === undefined) {
        console.error("--check-paths requires a <repoRoot> argument.");
        return 1;
      }
      continue;
    }
    rest.push(argv[i]);
  }
  const path = rest[0];
  if (!path || path === "-h" || path === "--help") {
    console.log(USAGE);
    return path ? 0 : 1;
  }

  let md: string;
  try {
    md = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`Cannot read ticket body at ${path}: ${(e as Error).message}`);
    return 1;
  }

  const result = validateTicketBody(md, repoRoot);
  if (result.ok) {
    console.log(`${path}: OK (all mandatory sections present)`);
    return 0;
  }
  console.error(`${path}: ${result.errors.length} schema error(s):`);
  for (const e of result.errors) console.error(`  [${e.code}] ${e.section}: ${e.message}`);
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
