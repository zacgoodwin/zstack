// Deep schema validation for `~/.zstack/projects/<slug>/config.json`. The
// required-key check in lib/config.ts catches a config that is missing a
// top-level key; this catches the structural failures that check can't -- a
// single-select field with no option map, a projectNumber that arrived as a
// string, a mistyped epicStyle -- and names the exact path so a hand-broken or
// half-written config fails loudly instead of surfacing as a confusing GraphQL
// error three subcommands later. /z-setup (C3) runs this on the config it builds
// before writing; loadConfig runs it on every read.
import {
  ADVERSARIAL_MODES,
  BoardConfig,
  FieldDataType,
  ZError,
} from "./config.ts";
import { loadRates, resolveRate } from "./estimate.ts";
import { EVENT_KEYS } from "./notify.ts";

const DATA_TYPES: FieldDataType[] = ["SINGLE_SELECT", "NUMBER", "TEXT"];

// The four stage names a stageModels key may name (lib/loop.ts's Stage type,
// duplicated here rather than imported to avoid a config.ts <-> config-schema.ts
// <-> loop.ts import cycle -- loop.ts already imports from config.ts).
const STAGE_NAMES = ["builder", "qa", "reviewer", "merge"];

// Shared shape behind every numeric config knob below: typeof/finite check,
// optional integer requirement, optional inclusive/exclusive bounds. One
// throw site so every knob's rejection follows the same rule; `desc` carries
// each knob's own rule text so the message stays specific (ponytail-audit
// #109 item 2 -- ALL numeric guards fold into this one function).
function requireNumber(
  key: string,
  v: unknown,
  opts: { min?: number; exclusiveMin?: boolean; max?: number; integer?: boolean; desc: string }
): void {
  if (v === undefined) return;
  const { min, exclusiveMin, max, integer, desc } = opts;
  const bad =
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (integer === true && !Number.isInteger(v)) ||
    (min !== undefined && (exclusiveMin ? v <= min : v < min)) ||
    (max !== undefined && v > max);
  if (bad) throw new ZError(`Config "${key}" must be ${desc}, got ${JSON.stringify(v)}.`);
}

// Positive-finite guard, exported so z-setup's pre-flight (F9, issue #14) can
// reject user-supplied numerics BEFORE any board mutation runs, with the exact
// same rule and error text as the config those numbers would become.
export function requirePositiveNumber(key: string, v: unknown): void {
  requireNumber(key, v, { min: 0, exclusiveMin: true, desc: "a positive number" });
}

function requireString(obj: any, key: string): void {
  if (typeof obj[key] !== "string" || !obj[key]) {
    throw new ZError(`Config "${key}" must be a non-empty string.`);
  }
}

// Validates one FieldConfig. `expectedType` pins the dataType (statusField must
// be SINGLE_SELECT); when a field is SINGLE_SELECT its option map must be a
// non-empty name -> non-empty-id record, because that map is the only thing that
// lets z-board translate a human option name into the id a GraphQL mutation
// needs.
function validateField(path: string, f: any, expectedType?: FieldDataType): void {
  if (typeof f !== "object" || f === null || Array.isArray(f)) {
    throw new ZError(`Config "${path}" must be an object.`);
  }
  if (typeof f.id !== "string" || !f.id) {
    throw new ZError(`Config "${path}.id" must be a non-empty string.`);
  }
  if (!DATA_TYPES.includes(f.dataType)) {
    throw new ZError(
      `Config "${path}.dataType" must be one of ${DATA_TYPES.join(", ")}, got ${JSON.stringify(f.dataType)}.`
    );
  }
  if (expectedType && f.dataType !== expectedType) {
    throw new ZError(`Config "${path}.dataType" must be ${expectedType}, got ${f.dataType}.`);
  }
  if (f.dataType === "SINGLE_SELECT") {
    if (
      typeof f.options !== "object" ||
      f.options === null ||
      Array.isArray(f.options) ||
      !Object.keys(f.options).length
    ) {
      throw new ZError(
        `Config "${path}.options" must be a non-empty {name: optionId} map for a single-select field.`
      );
    }
    for (const [name, id] of Object.entries(f.options)) {
      if (typeof id !== "string" || !id) {
        throw new ZError(`Config "${path}.options.${name}" must be a non-empty option id.`);
      }
    }
  }
}

// Throws a ZError naming the first bad path; returns the value typed as
// BoardConfig on success. Deliberately not a JSON-schema dependency (ponytail
// rung 1: the shape is fixed and small, a dozen guards beat a schema library and
// its dep tree).
export function validateConfig(cfg: unknown): BoardConfig {
  const c = cfg as any;
  if (typeof c !== "object" || c === null || Array.isArray(c)) {
    throw new ZError("Config must be a JSON object.");
  }
  for (const k of ["slug", "owner", "repo", "projectId", "repositoryId"]) {
    requireString(c, k);
  }
  if (typeof c.projectNumber !== "number" || !Number.isInteger(c.projectNumber)) {
    throw new ZError(`Config "projectNumber" must be an integer, got ${JSON.stringify(c.projectNumber)}.`);
  }

  validateField("statusField", c.statusField, "SINGLE_SELECT");

  if (typeof c.fields !== "object" || c.fields === null || Array.isArray(c.fields)) {
    throw new ZError(`Config "fields" must be an object of {name: FieldConfig}.`);
  }
  for (const [name, f] of Object.entries(c.fields)) {
    validateField(`fields.${name}`, f);
  }

  // Optional fields: validated only when present so hand-written configs that
  // omit them (loadConfig fills defaults) still pass.
  // "issue-type" is deliberately rejected until a sub-issue create path exists
  // (issue #14 item 6): a config carrying it advertises an epic style the loop
  // cannot act on. This check is the single enforcement point -- z-setup writes
  // through it and loadConfig reads through it, so board.ts never sees one.
  if (c.epicStyle === "issue-type") {
    throw new ZError(
      `Config "epicStyle" "issue-type" is not yet supported (no sub-issue create path exists yet; issue #14). Use "milestones".`
    );
  }
  if (c.epicStyle !== undefined && c.epicStyle !== "milestones") {
    throw new ZError(`Config "epicStyle" must be "milestones", got ${JSON.stringify(c.epicStyle)}.`);
  }
  for (const k of ["maxLanes", "watchdogMinutes", "lockStalenessMinutes", "maxQaPasses", "qaInvestigateAfter"]) {
    requirePositiveNumber(k, c[k]);
  }
  // auditEveryNLoops (issue #18): the /cso + /health end-of-loop cadence, an
  // integer >= 1 -- not requirePositiveNumber alone, since that guard accepts
  // fractions like 2.5 ("every 2.5th loop" is meaningless).
  requireNumber("auditEveryNLoops", c.auditEveryNLoops, { min: 1, integer: true, desc: "a positive integer (>= 1)" });
  // tickThrottleSeconds (issue #58): the minimum wall-clock seconds between
  // bin/z-loop-tick invocations. 0 (off, the default) is a required floor
  // value, so this can't reuse requirePositiveNumber (which rejects v <= 0).
  requireNumber("tickThrottleSeconds", c.tickThrottleSeconds, {
    min: 0,
    integer: true,
    desc: "a non-negative integer (0 = no throttling)",
  });
  // adversarialMode (issue #59): the reviewer super-truth control. Single
  // enforcement point -- z-setup writes through it, loadConfig reads through it,
  // and stage-prompts trusts the loaded value is one of the three. Validated
  // only when present so a config that omits it (loadConfig defaults it to
  // "non-trivial") still passes.
  if (c.adversarialMode !== undefined) validateAdversarialMode(c.adversarialMode);
  // minReviewerConfidence / reviewerBelowThresholdAction (issue #62): the
  // reviewer-confidence safety gate. minReviewerConfidence is an integer
  // percentage 0-100, so requirePositiveNumber (which rejects 0 and accepts
  // fractions/150) is the wrong guard.
  requireNumber("minReviewerConfidence", c.minReviewerConfidence, { min: 0, max: 100, integer: true, desc: "an integer 0-100" });
  if (
    c.reviewerBelowThresholdAction !== undefined &&
    !["block", "retry", "off"].includes(c.reviewerBelowThresholdAction)
  ) {
    throw new ZError(
      `Config "reviewerBelowThresholdAction" must be "block", "retry", or "off", got ${JSON.stringify(c.reviewerBelowThresholdAction)}.`
    );
  }
  // maxReviewBounces (issue #76): the reviewer->builder bounce cap. A count of
  // bounces, so -- unlike requirePositiveNumber's knobs -- a fraction is
  // meaningless too; not requirePositiveNumber (which would silently accept
  // e.g. 2.5).
  requireNumber("maxReviewBounces", c.maxReviewBounces, { min: 1, integer: true, desc: "a positive integer (>= 1)" });
  if (c.quota !== undefined) validateQuota(c.quota);

  // humanNeededPercent (issue #63): the mid-run breakdown notification's trip
  // threshold. `0` is a legitimate "disable" value (unlike maxLanes etc.), so
  // this is a non-negative-finite guard, not requirePositiveNumber.
  requireNumber("humanNeededPercent", c.humanNeededPercent, { min: 0, desc: "a non-negative number (0 disables)" });

  // notifications (#60): validated only when present (absent = off). The
  // discordWebhookUrl is a SECRET, so its error text names the field ONLY and
  // never echoes the value -- a pasted bare token or a leaked URL must not land
  // in a log line. This is the single enforcement point: z-setup writes through
  // it, loadConfig reads through it.
  if (c.notifications !== undefined) validateNotifications(c.notifications);

  // stageModels (issue #82): per-stage model routing. Validated only when
  // present -- absent means lib/loop.ts's resolveStageModel applies the pack
  // default ({merge: "haiku"}), and a config that omits the knob entirely
  // must keep passing. Keys are restricted to the four stage names; values
  // must resolve through the SAME rate-key lookup z-cost/z-estimate use
  // (resolveRate in lib/estimate.ts), so a typo'd model name fails here --
  // at config-write (z-setup) / config-load (loadConfig) time -- instead of
  // silently at spawn time.
  if (c.stageModels !== undefined) validateStageModels(c.stageModels);

  return c as BoardConfig;
}

// quota (issue #2)/notifications (#60)/adversarialMode (#59)/stageModels
// (#82): each extracted to its own exported validator so a second caller can
// shape-check ONE field in isolation. issue #97's priorOptionalFields (in
// lib/setup-board.ts) is that second caller: a hand-edited config.json may
// carry a validly-parsed but wrong-shape value in exactly one of these four
// fields, and that field alone must fall back to "nothing to preserve" rather
// than these throwing past a caller who only wants a per-field yes/no.
//
// Every `typeof x !== "object" || x === null` guard in this file (here and in
// validateField/validateConfig above) also rejects Array.isArray(x): a bare
// array passes `typeof [] === "object"` and `[] !== null`, so without this a
// hand-edited `quota: []` silently validated as a valid quota object, and
// #97's priorOptionalFields preserved it verbatim across a re-apply since it
// never throws (issue #106).
export function validateAdversarialMode(mode: unknown): void {
  if (!ADVERSARIAL_MODES.includes(mode as any)) {
    throw new ZError(
      `Config "adversarialMode" must be one of "off", "non-trivial", "always", got ${JSON.stringify(mode)}.`
    );
  }
}

export function validateQuota(quota: unknown): void {
  if (typeof quota !== "object" || quota === null || Array.isArray(quota)) {
    throw new ZError(`Config "quota" must be an object, not an array.`);
  }
  const q = quota as any;
  // Number.isFinite matters (issue #14 item 18): a NaN threshold passed the
  // old typeof/negative checks, and `remaining >= NaN` is always false -- the
  // quota guard would trip on EVERY call, sleeping or aborting forever.
  if (q.threshold !== undefined && (typeof q.threshold !== "number" || !Number.isFinite(q.threshold) || q.threshold < 0)) {
    throw new ZError(`Config "quota.threshold" must be a non-negative number.`);
  }
  if (q.mode !== undefined && q.mode !== "sleep" && q.mode !== "abort") {
    throw new ZError(`Config "quota.mode" must be "sleep" or "abort", got ${JSON.stringify(q.mode)}.`);
  }
}

// notifications (#60): the discordWebhookUrl is a SECRET, so its error text
// names the field ONLY and never echoes the value -- a pasted bare token or a
// leaked URL must not land in a log line.
export function validateNotifications(notifications: unknown): void {
  const n = notifications as any;
  if (typeof n !== "object" || n === null || Array.isArray(n)) {
    throw new ZError(`Config "notifications" must be an object, not an array.`);
  }
  if (n.enabled !== undefined && typeof n.enabled !== "boolean") {
    throw new ZError(`Config "notifications.enabled" must be a boolean.`);
  }
  // A bare token (no scheme) is the classic paste error; require https:// so it
  // is rejected loudly. Value is never interpolated into the message.
  if (
    n.discordWebhookUrl !== undefined &&
    (typeof n.discordWebhookUrl !== "string" || !n.discordWebhookUrl.startsWith("https://"))
  ) {
    throw new ZError(
      `Config "notifications.discordWebhookUrl" must be a non-empty string beginning with "https://" (a bare token is not a webhook URL).`
    );
  }
  if (n.events !== undefined) {
    if (typeof n.events !== "object" || n.events === null || Array.isArray(n.events)) {
      throw new ZError(`Config "notifications.events" must be an object of {event: boolean}.`);
    }
    for (const [k, v] of Object.entries(n.events)) {
      if (!(EVENT_KEYS as readonly string[]).includes(k)) {
        throw new ZError(`Config "notifications.events.${k}" is not a known event. Valid: ${EVENT_KEYS.join(", ")}`);
      }
      if (typeof v !== "boolean") {
        throw new ZError(`Config "notifications.events.${k}" must be a boolean.`);
      }
    }
  }
}

// stageModels (issue #82): keys restricted to the four stage names; values
// must resolve through the SAME rate-key lookup z-cost/z-estimate use
// (resolveRate in lib/estimate.ts), so a typo'd model name fails here.
export function validateStageModels(stageModels: unknown): void {
  if (typeof stageModels !== "object" || stageModels === null || Array.isArray(stageModels)) {
    throw new ZError(`Config "stageModels" must be an object of {stage: model}.`);
  }
  const rates = loadRates();
  for (const [stage, model] of Object.entries(stageModels as Record<string, unknown>)) {
    if (!STAGE_NAMES.includes(stage)) {
      throw new ZError(`Config "stageModels.${stage}" is not a known stage. Valid: ${STAGE_NAMES.join(", ")}.`);
    }
    if (typeof model !== "string" || !model) {
      throw new ZError(`Config "stageModels.${stage}" must be a non-empty string.`);
    }
    try {
      resolveRate(model, rates);
    } catch {
      throw new ZError(
        `Config "stageModels.${stage}" is not a known model rate key, got ${JSON.stringify(model)}. ` +
          `Known: ${Object.keys(rates.rates).join(", ")}.`
      );
    }
  }
}
