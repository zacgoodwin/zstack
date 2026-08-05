// Contract shape for `~/.zstack/projects/<slug>/config.json`, the single source
// of truth for board IDs. /z-setup (child C3) WRITES this file; z-board only
// READS it. Both sides import this type so the seam stays typed and versioned.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "./config-schema.ts";
import type { EventKey } from "./notify.ts";

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

// The adversarial-reviewer control (issue #59). Per project, chosen at setup or
// hand-edited: never fan out skeptics ("off"), fan out only when a card's blast
// radius earns it ("non-trivial" -- the default: diff >= 10 changed lines OR a
// security/migration/payments/auth label), or always ("always"). Consumed at
// reviewer-spawn time (lib/stage-prompts.ts adversarialActive), not threaded
// through LoopState. Single source of the enum for config-schema + stage-prompts.
export type AdversarialMode = "off" | "non-trivial" | "always";
export const ADVERSARIAL_MODES: AdversarialMode[] = ["off", "non-trivial", "always"];

// The owner's bot-vs-human-account choice for the loop's GitHub identity
// (issue #66): whether /z-loop runs as a dedicated bot collaborator or
// continues under the human owner's own `gh` login. This is never a second
// copy of a login -- ME is always `gh api user -q .login` (z-loop/SKILL.md
// Step 0) and stays the single source of truth -- only the human's recorded
// DECISION, so /z-setup and /z-update know whether to raise the choice
// (absent) or leave it alone (already answered, either way).
export type IdentityChoice = "bot" | "human";
export const IDENTITY_MODES: IdentityChoice[] = ["bot", "human"];

export interface IdentityRecord {
  mode: IdentityChoice;
  recordedAt: string; // ISO 8601, when the choice was (re)recorded
  // Human-facing note of where the bot's token/gh-auth profile lives (e.g.
  // "gh auth login (bot profile)" or "GH_TOKEN env var in the loop's launch
  // script"). "bot" mode only; never a login or the token itself.
  tokenLocation?: string;
}

// Per-stage model routing (issue #82): overrides the ticket's board Model
// field for one or more of the loop's four stage spawns. Not a Stage-keyed
// import from lib/loop.ts (that would cycle back through this file) -- the
// four literal names are duplicated here and re-checked in config-schema.ts.
// Deliberately NOT defaulted by loadConfig below: the resolver
// (lib/loop.ts resolveStageModel) is the one place that must tell "key
// absent" (apply the pack default) apart from "key present as {}" (explicit
// opt-out, no default). Filling a default here would collapse that
// distinction before the resolver ever sees it.
export type StageModels = Partial<Record<"builder" | "qa" | "reviewer" | "merge", string>>;

// Per-stage watchdog budgets (#256), in minutes of observed subtree SILENCE. The
// four literal names are duplicated for the same reason StageModels duplicates
// them: importing Stage from lib/loop.ts would cycle back through this file.
//
// UNLIKE StageModels, an absent key here IS defaulted (resolveWatchdogMinutes
// falls back to DEFAULT_STAGE_WATCHDOG_MINUTES). There is no "explicit opt-out"
// reading to preserve: a stage with no watchdog at all is a stage that can hang
// forever, which is the failure this whole knob exists to bound.
export type StageWatchdogMinutes = Partial<Record<"builder" | "qa" | "reviewer" | "merge", number>>;

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
  // Minutes of observed worker SILENCE before the loop probes a lane (#256: the
  // baseline is the newest append in the stage's spawn subtree, not the moment
  // the stage started). See DEFAULT_STAGE_WATCHDOG_MINUTES for the derivation.
  //
  // Two accepted shapes. A NUMBER applies one budget to every stage (what every
  // config written before #256 carries, and still byte-identical in behavior). An
  // OBJECT gives each stage its own, which is what the measurements actually
  // support: a reviewer blocked on three background skeptics legitimately goes 19
  // minutes silent, while a merge stage that runs `gh pr merge` never goes 2. An
  // absent stage key falls back to that stage's shipped default, so
  // `{"reviewer": 60}` is a one-stage override, not a redefinition of the table.
  watchdogMinutes?: number | StageWatchdogMinutes;
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
  // Adversarial-reviewer control (issue #59): whether the Review stage fans out
  // independent skeptic sub-agents (super-truth) for a card, and when. Read only
  // at reviewer-spawn time; #62 gates on the confidence this mode emits.
  adversarialMode?: AdversarialMode;
  quota?: Partial<QuotaConfig>;
  // Minimum wall-clock seconds between bin/z-loop-tick invocations (issue
  // #58); 0 = no throttling (default, today's behavior). Proactive pacing
  // that keeps ProjectsV2 GraphQL point spend under GitHub's 5k/hr budget;
  // complements the REACTIVE enforceQuota() backstop (board.ts:199-234),
  // which only intervenes once remaining points are already low.
  tickThrottleSeconds?: number;
  // The reviewer-confidence safety gate (issue #62): the aggregated confidence
  // (0-100) #59's reviewer stamps into its REVIEW-APPROVE marker must clear
  // this floor to merge; below it, reviewerBelowThresholdAction decides what
  // happens ("block" parks Blocked with a truth-check note, "retry" bounces to
  // the builder, "off" disables the gate -- the pre-#62 behavior). A reviewer
  // approval with no parseable confidence is fail-closed the same as a
  // below-floor score, whenever the gate is on.
  minReviewerConfidence?: number;
  reviewerBelowThresholdAction?: "block" | "retry" | "off";
  // Reviewer->builder bounce cap (issue #76): both routes that send a ticket
  // back to the builder from Review (a `REVIEW-FINDINGS`, and a
  // reviewerBelowThresholdAction "retry") draw on one shared bounce budget --
  // at this many bounces the ticket parks Blocked instead of looping
  // builder->QA->review forever. Same optional-with-fallback treatment as the
  // gate knobs above.
  maxReviewBounces?: number;
  // Skeptic quorum floor (issue #191): how many of the 3 skeptic verdicts an
  // ADVERSARIAL review must actually have received for its aggregated confidence
  // to merge. The confidence token alone cannot express this, and the gap is not
  // theoretical: one skeptic reporting "cannot refute" aggregates to
  // confidence=100, clears the default floor of 70, and merges as though three
  // independent reviews agreed. Default 2 -- a majority of the fan-out had to
  // look. 0 disables the gate; 1 accepts a single opinion as an adversarial pass,
  // which is the hole this closes, so lower it only deliberately. A short quorum
  // re-spawns the REVIEWER once (a thin review is not a bad diff), then parks
  // Blocked. Only ever consulted when the reviewer emitted a `skeptics=` token,
  // so a project with adversarialMode "off" is entirely unaffected.
  minSkepticQuorum?: number;
  // Safety control (issue #63): mid-run breakdown notification when parked
  // tickets (Blocked + Skipped + Questions) exceed this percent of the
  // batch's initial committed-to-Building count. 0 disables the control.
  humanNeededPercent?: number;
  // Per-loop ticket cap (issue #131): the maximum number of tickets a single
  // /z-loop run flags into its batch. 0 (the default) = no cap -- every gated
  // Ready ticket is workable, byte-identical to pre-#131. The batch is a
  // dependency-self-contained allow-list captured once per run
  // (lib/lanes.ts selectBatch); the leftover Ready tickets simply wait for a
  // future run. Read at Step 3 ingest only.
  ticketLimit?: number;
  // Context ceiling (issue #131): the live orchestrator context-window token
  // occupancy (input + cache-read + cache-creation of its most recent request,
  // measured by lib/context-budget.ts) at/above which the loop stops claiming
  // NEW tickets and, once every lane is idle with batch work still remaining,
  // returns a `context-clear` pause so the operator/harness can clear context
  // and re-invoke to resume the same batch. 0 disables the gate. Default
  // 550000 -- below the harness auto-compaction point, with headroom.
  contextTokenLimit?: number;
  // Discord notifications for the loop/plan events (#60, #63, #68). Absent block = off (a
  // no-op), which is the correct default -- so there is deliberately no
  // DEFAULT_NOTIFICATIONS const and no loadConfig mutation. The URL is a SECRET:
  // config.json lives at ~/.zstack/projects/<slug>/config.json, OUTSIDE the repo
  // (.gitignore is N/A), and may instead come from ZSTACK_DISCORD_WEBHOOK.
  notifications?: {
    discordWebhookUrl?: string; // SECRET; env ZSTACK_DISCORD_WEBHOOK wins over it
    enabled?: boolean; // master switch (default on when the block is present)
    events?: Partial<Record<EventKey, boolean>>; // per-state toggles (each default on)
  };
  // Per-stage model overrides (issue #82). Absent entirely -> lib/loop.ts's
  // resolveStageModel applies the pack default ({merge: "haiku"}); present
  // (including {}) -> used exactly as written, no default layered on. See the
  // StageModels comment above for why loadConfig must never fill this in.
  stageModels?: StageModels;
  // Issue #66: the owner's recorded bot-vs-human-account choice. Absent means
  // "never asked" (a project that predates this ticket) -- deliberately NOT
  // defaulted by loadConfig below (unlike every numeric knob above), because
  // "absent" and "chose human" must stay distinguishable: that distinction is
  // what lets z-update's re-check (SKILL.md) prompt an old project exactly
  // once and never re-prompt one that already answered either way.
  identity?: IdentityRecord;
}

export const DEFAULT_QUOTA: QuotaConfig = { threshold: 100, mode: "sleep" };
export const DEFAULT_EPIC_STYLE: EpicStyle = "milestones";
export const DEFAULT_MAX_LANES = 3;
// Minutes of subtree SILENCE that expire a stage. A MEASUREMENT, not a round
// number, and it is only meaningful at all since #256 made lastActivityMs a
// silence baseline instead of a stage-age one.
//
// The population is the same one lib/transcripts.ts derives SUBTREE_QUIET_MS
// from: the longest gap between a WORKING agent's own transcript records, over
// 9,589 mid-work samples across 1,388 sub-agent transcripts on this machine --
// MEASURED_MIDWORK_GAP_MS = 423,110 ms (p50 1.5s, p90 7.4s, p99 34s). A silence
// budget under that ceiling declares a healthy agent dead, so this pack clears it
// by 2x wherever it decides something on silence: 2 x 423,110 = 846,220 ms
// = 14.1 min, rounded up to 15. Identical to SUBTREE_QUIET_MS by construction,
// because it is the same question asked of the same evidence.
//
// The old 10 predates the measurement and cleared that ceiling by only 1.42x --
// on the decision that DISCARDS A WHOLE TICKET, where SUBTREE_QUIET_MS's 2x only
// risks leaving one scratch worktree behind. tests/loop.test.ts pins the ratio so
// a future edit cannot quietly drop back under it.
//
// This is the FLOOR every per-stage budget below is held to, and the value a
// scalar `watchdogMinutes` in an existing config keeps meaning for every stage.
export const DEFAULT_WATCHDOG_MINUTES = 15;

// Per-stage silence budgets (#256), each derived from two measured ceilings and
// held to whichever is larger:
//
//   1. the AGENT-level ceiling, MEASURED_MIDWORK_GAP_MS = 423,110 ms over 9,589
//      mid-work samples across 1,388 sub-agent transcripts -- the floor above,
//      2x-ed and rounded to 15 minutes. It applies to every stage because any
//      agent can produce it; a smaller per-family sample never licenses going
//      under it.
//   2. that stage family's OWN measured worst silence,
//      MEASURED_STAGE_SILENCE_MS (lib/transcripts.ts), over 1,143 real stage
//      subtrees from this repo's loop runs.
//
// So: minutes = round-up(max(2 x 423,110 ms, 2 x that family's max)), and the
// rounding goes UP to the next 5 minutes for the same asymmetry SUBTREE_QUIET_MS
// rounds up on -- being too patient costs a longer wait before a dead worker is
// noticed, being too tight discards a healthy ticket's work.
//
//   builder   2 x 607,966 ms   = 20.3 min -> 25
//   qa        2 x 174,847 ms   =  5.8 min -> the 15-minute floor wins
//   reviewer  2 x 1,161,119 ms = 38.7 min -> 40
//   merge     2 x  97,130 ms   =  3.2 min -> the 15-minute floor wins
//
// The qa and merge rows are the point of the floor: their families' samples hold
// no long quiet stretch, and shipping 6 and 4 would kill any QA agent that sits
// on one slow build. tests/loop.test.ts pins every row against BOTH ceilings.
export const DEFAULT_STAGE_WATCHDOG_MINUTES: Required<StageWatchdogMinutes> = {
  builder: 25,
  qa: 15,
  reviewer: 40,
  merge: 15,
};

// The budget for one stage, from either accepted config shape (#256). A number
// applies to every stage (pre-#256 behavior, byte-identical); an object gives
// each stage its own with a per-key fallback to the shipped default; absent is
// the shipped default outright.
//
// One resolver, called by the state machine at the moment it judges ONE lane --
// so a config that changes shape can never leave half the loop reading a number
// the other half resolved differently.
export function resolveWatchdogMinutes(
  value: number | StageWatchdogMinutes | undefined,
  stage: keyof StageWatchdogMinutes
): number {
  if (typeof value === "number") return value;
  return value?.[stage] ?? DEFAULT_STAGE_WATCHDOG_MINUTES[stage];
}
export const DEFAULT_LOCK_STALENESS_MINUTES = 60;
export const DEFAULT_AUDIT_EVERY_N_LOOPS = 5;
export const DEFAULT_MAX_QA_PASSES = 3;
export const DEFAULT_QA_INVESTIGATE_AFTER = 2;
export const DEFAULT_ADVERSARIAL_MODE: AdversarialMode = "non-trivial";
export const DEFAULT_TICK_THROTTLE_SECONDS = 0;
export const DEFAULT_MIN_REVIEWER_CONFIDENCE = 70;
export const DEFAULT_REVIEWER_BELOW_THRESHOLD_ACTION = "block" as const;
export const DEFAULT_MAX_REVIEW_BOUNCES = 2;
export const DEFAULT_MIN_SKEPTIC_QUORUM = 2;
export const DEFAULT_HUMAN_NEEDED_PERCENT = 30;
export const DEFAULT_TICKET_LIMIT = 0;
export const DEFAULT_CONTEXT_TOKEN_LIMIT = 550000;

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
  // #256: the per-stage TABLE, not the scalar, so a project that never set this
  // knob actually gets the four derived budgets. A scalar already on disk is left
  // exactly as written (one budget for every stage, pre-#256 behavior), and a
  // partial object is left partial -- resolveWatchdogMinutes fills each missing
  // stage, which is what makes `{"reviewer": 60}` a one-stage override that keeps
  // tracking the pack's defaults for the other three.
  cfg.watchdogMinutes = cfg.watchdogMinutes ?? { ...DEFAULT_STAGE_WATCHDOG_MINUTES };
  cfg.lockStalenessMinutes = cfg.lockStalenessMinutes ?? DEFAULT_LOCK_STALENESS_MINUTES;
  cfg.auditEveryNLoops = cfg.auditEveryNLoops ?? DEFAULT_AUDIT_EVERY_N_LOOPS;
  cfg.maxQaPasses = cfg.maxQaPasses ?? DEFAULT_MAX_QA_PASSES;
  cfg.qaInvestigateAfter = cfg.qaInvestigateAfter ?? DEFAULT_QA_INVESTIGATE_AFTER;
  cfg.adversarialMode = cfg.adversarialMode ?? DEFAULT_ADVERSARIAL_MODE;
  cfg.tickThrottleSeconds = cfg.tickThrottleSeconds ?? DEFAULT_TICK_THROTTLE_SECONDS;
  cfg.minReviewerConfidence = cfg.minReviewerConfidence ?? DEFAULT_MIN_REVIEWER_CONFIDENCE;
  cfg.reviewerBelowThresholdAction = cfg.reviewerBelowThresholdAction ?? DEFAULT_REVIEWER_BELOW_THRESHOLD_ACTION;
  cfg.maxReviewBounces = cfg.maxReviewBounces ?? DEFAULT_MAX_REVIEW_BOUNCES;
  cfg.minSkepticQuorum = cfg.minSkepticQuorum ?? DEFAULT_MIN_SKEPTIC_QUORUM;
  cfg.humanNeededPercent = cfg.humanNeededPercent ?? DEFAULT_HUMAN_NEEDED_PERCENT;
  cfg.ticketLimit = cfg.ticketLimit ?? DEFAULT_TICKET_LIMIT;
  cfg.contextTokenLimit = cfg.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
  return cfg;
}
