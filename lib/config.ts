// Contract shape for `~/.zstack/projects/<slug>/config.json`, the single source
// of truth for board IDs. /z-setup (child C3) WRITES this file; z-board only
// READS it. Both sides import this type so the seam stays typed and versioned.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FieldDataType = "SINGLE_SELECT" | "NUMBER" | "TEXT";

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

export interface BoardConfig {
  slug: string;
  owner: string; // repo owner, for repository/issue lookups
  repo: string; // repo name
  projectNumber: number; // ProjectV2 number (disambiguates an issue's items)
  projectId: string; // ProjectV2 node ID (mutations target this)
  repositoryId: string; // Repository node ID, for createIssue
  statusField: FieldConfig; // the board's single-select Status field
  fields: Record<string, FieldConfig>; // Model | Model Effort | Estimate | Actual
  quota?: Partial<QuotaConfig>;
}

export const DEFAULT_QUOTA: QuotaConfig = { threshold: 200, mode: "sleep" };

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

  cfg.quota = { ...DEFAULT_QUOTA, ...(cfg.quota ?? {}) };
  return cfg;
}
