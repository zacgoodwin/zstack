// Contract shape for `~/.zstack/projects/<slug>/config.json`, the single source
// of truth for board IDs. /z-setup (child C3) WRITES this file; z-board only
// READS it. Both sides import this type so the seam stays typed and versioned.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "./config-schema.ts";

export type FieldDataType = "SINGLE_SELECT" | "NUMBER" | "TEXT";

// The canonical nine board statuses (z-setup writes them as the Status field's
// options; the loop enforces transitions over them). Single source for the
// whole pack (issue #14 item 21) -- lib/loop.ts re-exports for its importers.
export type BoardStatus =
  | "Backlog"
  | "Ready"
  | "Questions"
  | "Building"
  | "QA"
  | "Review"
  | "Blocked"
  | "Skipped"
  | "Done";

export const BOARD_STATUSES: BoardStatus[] = [
  "Backlog", "Ready", "Questions", "Building", "QA", "Review", "Blocked", "Skipped", "Done",
];

// Terminal-for-this-batch statuses: the work landed (Done) or a human parked
// it. The batch is drained when every ticket sits in one of these; reconcile
// never reopens one; a human moving an in-flight ticket here stops its lane.
// Order matters only to lib/endloop.ts's report, which lists counts in this
// sequence.
export const TERMINAL_STATUSES: BoardStatus[] = ["Done", "Questions", "Blocked", "Skipped"];

// A ProjectV2 field: its node ID, its value type, and (single-select only) the
// map from human option name -> option node ID. GraphQL mutations need the IDs;
// humans pass the names.
export interface FieldConfig {
  id: string;
  dataType: FieldDataType;
  options?: Record<string, string>;
}

export interface QuotaConfig {
  // Guard trips when remaining points fall below this (issue #2).
  threshold: number;
  // What to do when tripped: wait for the window to reset, or fail fast.
  mode: "sleep" | "abort";
}

// How epics are modeled on the board (chosen once, at /z-setup): a GitHub
// milestone per epic (recommended) or a parent issue with sub-issue relations.
export type EpicStyle = "milestones" | "issue-type";

export interface BoardConfig {
  slug: string;
  owner: string; // repo owner, for repository/issue lookups
  repo: string; // repo name
  projectNumber: number; // ProjectV2 number (disambiguates an issue's items)
  projectId: string; // ProjectV2 node ID (mutations target this)
  repositoryId: string; // Repository node ID, for createIssue
  statusField: FieldConfig; // the board's single-select Status field
  fields: Record<string, FieldConfig>; // Model | Model Effort | Estimate | Actual
  epicStyle?: EpicStyle; // set at /z-setup; defaults to "milestones"
  maxLanes?: number; // max concurrent workers (PROCESS.md: no more than 3)
  watchdogMinutes?: number; // stuck-worker timeout in minutes (PROCESS.md: 10)
  // A project loop lock (lib/locks.ts) with no verifiable pid and older than this
  // is judged stale rather than live, so a crashed loop's lock never wedges the
  // next /z-loop (C7, issue #2). Sized well above a realistic batch so two near-
  // simultaneous invocations still see each other's lock as live and refuse.
  lockStalenessMinutes?: number;
  // How often (in loops) the end-of-loop stage runs the /cso + /health audits
  // (issue #18): loopCount % auditEveryNLoops === 0. Projects differ -- a
  // high-churn repo may want 3, a docs-only repo 10 -- so this lives per
  // project rather than hardcoded in lib/endloop.ts.
  auditEveryNLoops?: number;
  // QA bounce knobs (issue #41), siblings of maxLanes/watchdogMinutes: how many
  // QA passes before a still-buggy ticket parks Blocked (PROCESS.md step 16),
  // and the QA-bounce count at/after which the rebuild runs /investigate first
  // (PROCESS.md step 15) instead of a direct patch.
  maxQaPasses?: number;
  qaInvestigateAfter?: number;
  quota?: Partial<QuotaConfig>;
}

export const DEFAULT_QUOTA: QuotaConfig = { threshold: 200, mode: "sleep" };
export const DEFAULT_EPIC_STYLE: EpicStyle = "milestones";
export const DEFAULT_MAX_LANES = 3;
export const DEFAULT_WATCHDOG_MINUTES = 10;
export const DEFAULT_LOCK_STALENESS_MINUTES = 60;
export const DEFAULT_AUDIT_EVERY_N_LOOPS = 5;
export const DEFAULT_MAX_QA_PASSES = 3;
export const DEFAULT_QA_INVESTIGATE_AFTER = 2;

// Every actionable failure in the pack is a ZError; main() prints .message to
// stderr and exits non-zero. Anything else is a bug and bubbles up with a stack.
export class ZError extends Error {}

const REQUIRED_KEYS: (keyof BoardConfig)[] = [
  "slug",
  "owner",
  "repo",
  "projectNumber",
  "projectId",
  "repositoryId",
  "statusField",
  "fields",
];

const SETUP_HINT = "Run /z-setup to create it.";

export function projectsDir(home = homedir()): string {
  return join(home, ".zstack", "projects");
}

export function configPath(slug: string, home = homedir()): string {
  return join(projectsDir(home), slug, "config.json");
}

// Which project config to use, in order: explicit --slug, ZSTACK_SLUG, or (when
// exactly one project is configured) that one. Ambiguity is an error, never a
// silent guess.
export function resolveSlug(explicit?: string, home = homedir()): string {
  const chosen = explicit ?? process.env.ZSTACK_SLUG;
  if (chosen) return chosen;

  const dir = projectsDir(home);
  let slugs: string[] = [];
  try {
    slugs = readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    slugs = [];
  }

  if (slugs.length === 1) return slugs[0];
  if (slugs.length === 0) {
    throw new ZError(`No zstack project configured under ${dir}. ${SETUP_HINT}`);
  }
  throw new ZError(
    `Multiple zstack projects configured (${slugs.join(", ")}). ` +
      `Pass --slug <name> or set ZSTACK_SLUG.`
  );
}

export function loadConfig(slug?: string, home = homedir()): BoardConfig {
  const resolved = resolveSlug(slug, home);
  const path = configPath(resolved, home);
  if (!existsSync(path)) {
    throw new ZError(
      `No zstack config for "${resolved}" at ${path}. ${SETUP_HINT}`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Config at ${path} is not valid JSON: ${(e as Error).message}`);
  }

  const cfg = raw as BoardConfig;
  const missing = REQUIRED_KEYS.filter((k) => cfg[k] === undefined || cfg[k] === null);
  if (missing.length) {
    throw new ZError(
      `Config at ${path} is missing: ${missing.join(", ")}. ${SETUP_HINT}`
    );
  }

  // Deep structural validation (single-select option maps, field dataTypes,
  // enum/number shapes). The required-key check above stays first so a config
  // that is only missing top-level keys keeps its original "missing: ..." error.
  try {
    validateConfig(cfg);
  } catch (e) {
    if (e instanceof ZError) throw new ZError(`Config at ${path} is invalid: ${e.message}`);
    throw e;
  }

  cfg.quota = { ...DEFAULT_QUOTA, ...(cfg.quota ?? {}) };
  cfg.epicStyle = cfg.epicStyle ?? DEFAULT_EPIC_STYLE;
  cfg.maxLanes = cfg.maxLanes ?? DEFAULT_MAX_LANES;
  cfg.watchdogMinutes = cfg.watchdogMinutes ?? DEFAULT_WATCHDOG_MINUTES;
  cfg.lockStalenessMinutes = cfg.lockStalenessMinutes ?? DEFAULT_LOCK_STALENESS_MINUTES;
  cfg.auditEveryNLoops = cfg.auditEveryNLoops ?? DEFAULT_AUDIT_EVERY_N_LOOPS;
  cfg.maxQaPasses = cfg.maxQaPasses ?? DEFAULT_MAX_QA_PASSES;
  cfg.qaInvestigateAfter = cfg.qaInvestigateAfter ?? DEFAULT_QA_INVESTIGATE_AFTER;
  return cfg;
}
