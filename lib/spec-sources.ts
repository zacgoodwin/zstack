// Deterministic planning-document discovery for /z-plan (issue #16). Before
// this, Step 1 resolved exactly one spec file (the newest file in gstack's
// ceo-plans/ dir), so a plan grounded on only that file missed scope recorded
// in gstack's other planning artifacts under
// `~/.gstack/projects/<slug>/` -- specs/, plus test-plan and checkpoint
// markdown files observed live on other projects. "Which files exist, sorted
// by mtime" is a plain filesystem listing, so it belongs in a script with
// tests (PRINCIPLES.md latent vs deterministic), never in z-plan's prose.
//
// Windows quirk (issue #22): Bun.Glob does not match absolute drive-letter
// patterns (e.g. "D:\...\specs\*.md"), so this module lists directories with
// readdirSync + statSync instead of Bun.Glob.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { handleCliError } from "./cli.ts";
import { ZError } from "./config.ts";

export { ZError } from "./config.ts";

export type SpecSourceKind = "specs" | "ceo-plans" | "test-plan" | "checkpoints";

export interface SpecSource {
  path: string; // absolute path
  kind: SpecSourceKind;
  mtimeMs: number;
}

// Kind precedence, in search/output order: `specs` and `ceo-plans` are the
// primary-spec candidates (a no-arg /z-plan picks the newest entry across
// just these two kinds as its primary spec -- z-plan/SKILL.md Step 1);
// `test-plan` and `checkpoints` are mandatory grounding context only. This
// order is fixed -- it is NOT re-derived from mtime across kinds, only mtime
// WITHIN a kind is a sort key (see discoverSpecSources below).
const CATEGORIES: {
  kind: SpecSourceKind;
  // Directory to scan, relative to the project dir; null means the project
  // dir itself -- gstack's `*-test-plan-*.md` files observed live are loose
  // files at the project root, not under their own subdirectory.
  subdir: string | null;
  matches: (name: string) => boolean;
}[] = [
  { kind: "specs", subdir: "specs", matches: (n) => n.endsWith(".md") },
  { kind: "ceo-plans", subdir: "ceo-plans", matches: (n) => n.endsWith(".md") },
  { kind: "test-plan", subdir: null, matches: (n) => n.endsWith(".md") && n.includes("-test-plan-") },
  { kind: "checkpoints", subdir: "checkpoints", matches: (n) => n.endsWith(".md") },
];

function categoryDir(projectDir: string, subdir: string | null): string {
  return subdir === null ? projectDir : join(projectDir, subdir);
}

// Every directory this module searches for `projectDir`, in category order.
// Shared by discoverSpecSources's empty-result error message so "every
// directory it searched" (the contract) is generated once, not duplicated
// between the error path and any caller that wants to preview the search list.
export function searchedDirs(projectDir: string): string[] {
  return CATEGORIES.map((c) => categoryDir(projectDir, c.subdir));
}

// Files directly in `dir` (one level, non-recursive) whose name passes
// `matches`, each stat'd for mtimeMs. A missing directory is not an error --
// most projects have no checkpoints/ dir -- but any other readdir/stat
// failure (ENOTDIR, EACCES) fails loud rather than silently reporting empty,
// the same contract lib/locks.ts's listLaneLocks uses (F13: never render a
// plausible-but-false "nothing here" when the real problem is unreadable).
function listCategory(dir: string, matches: (name: string) => boolean): { path: string; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw new ZError(`Cannot read ${dir}: ${e?.message ?? e}`);
  }
  const out: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!matches(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch (e: any) {
      throw new ZError(`Cannot stat ${path}: ${e?.message ?? e}`);
    }
    if (!st.isFile()) continue; // a directory that happens to match the glob is not a document
    out.push({ path, mtimeMs: st.mtimeMs });
  }
  return out;
}

// Discovers every planning document under a gstack project dir. Ordering
// (issue #16 contract): newest-first WITHIN a kind (mtimeMs descending, path
// ascending tiebreak for equal mtimes -- some filesystems' mtime resolution is
// coarse enough that two files written in the same batch tie), kinds
// concatenated in CATEGORIES order so specs/ceo-plans sort before
// test-plan/checkpoints. Throws ZError naming every searched directory (AC3)
// when nothing is found anywhere.
export function discoverSpecSources(projectDir: string): SpecSource[] {
  const out: SpecSource[] = [];
  for (const cat of CATEGORIES) {
    const dir = categoryDir(projectDir, cat.subdir);
    const entries = listCategory(dir, cat.matches);
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const e of entries) out.push({ path: e.path, kind: cat.kind, mtimeMs: e.mtimeMs });
  }
  if (out.length === 0) {
    throw new ZError(
      `No planning documents found under ${projectDir}. Searched: ${searchedDirs(projectDir).join(", ")}.`
    );
  }
  return out;
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `spec-sources <gstack-project-dir>

  Discovers gstack's planning documents for a project: specs/*.md,
  ceo-plans/*.md, *-test-plan-*.md, and checkpoints/*.md. Prints the JSON list
  ({path, kind, mtimeMs}[]) to stdout, newest-first within each kind, with
  specs/ceo-plans ordered before test-plan/checkpoints. Exit 0 on success;
  exit 1 (message on stderr naming every directory searched) when nothing is
  found, or on a usage/read error.`;

export function main(argv: string[]): number {
  const dir = argv[0];
  if (!dir || dir === "-h" || dir === "--help") {
    console.log(USAGE);
    return dir ? 0 : 1;
  }
  try {
    const sources = discoverSpecSources(dir);
    console.log(JSON.stringify(sources));
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
