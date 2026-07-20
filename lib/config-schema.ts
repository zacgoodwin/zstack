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
import { EVENT_KEYS } from "./notify.ts";

const DATA_TYPES: FieldDataType[] = ["SINGLE_SELECT", "NUMBER", "TEXT"];

// Positive-finite guard, exported so z-setup's pre-flight (F9, issue #14) can
// reject user-supplied numerics BEFORE any board mutation runs, with the exact
// same rule and error text as the config those numbers would become.
export function requirePositiveNumber(key: string, v: unknown): void {
  if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
    throw new ZError(`Config "${key}" must be a positive number, got ${JSON.stringify(v)}.`);
  }
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
  if (typeof f !== "object" || f === null) {
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
    if (typeof f.options !== "object" || f.options === null || !Object.keys(f.options).length) {
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
  if (typeof c !== "object" || c === null) {
    throw new ZError("Config must be a JSON object.");
  }
  for (const k of ["slug", "owner", "repo", "projectId", "repositoryId"]) {
    requireString(c, k);
  }
  if (typeof c.projectNumber !== "number" || !Number.isInteger(c.projectNumber)) {
    throw new ZError(`Config "projectNumber" must be an integer, got ${JSON.stringify(c.projectNumber)}.`);
  }

  validateField("statusField", c.statusField, "SINGLE_SELECT");

  if (typeof c.fields !== "object" || c.fields === null) {
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
  // auditEveryNLoops (issue #18): the /cso + /health end-of-loop cadence. One
  // combined check (the isInteger half of projectNumber's pattern at lines
  // 78-80, plus a >= 1 floor) so every rejected value -- 0, a negative, NaN,
  // a string, or a fraction like 2.5 ("every 2.5th loop" is meaningless) --
  // gets the same "positive integer (>= 1)" message naming the field. Not
  // requirePositiveNumber alone: that guard accepts fractions, which this
  // knob must not.
  if (
    c.auditEveryNLoops !== undefined &&
    (typeof c.auditEveryNLoops !== "number" || !Number.isInteger(c.auditEveryNLoops) || c.auditEveryNLoops < 1)
  ) {
    throw new ZError(
      `Config "auditEveryNLoops" must be a positive integer (>= 1), got ${JSON.stringify(c.auditEveryNLoops)}.`
    );
  }
  // adversarialMode (issue #59): the reviewer super-truth control. Single
  // enforcement point -- z-setup writes through it, loadConfig reads through it,
  // and stage-prompts trusts the loaded value is one of the three. Validated
  // only when present so a config that omits it (loadConfig defaults it to
  // "non-trivial") still passes.
  if (c.adversarialMode !== undefined && !ADVERSARIAL_MODES.includes(c.adversarialMode)) {
    throw new ZError(
      `Config "adversarialMode" must be one of "off", "non-trivial", "always", got ${JSON.stringify(c.adversarialMode)}.`
    );
  }
  if (c.quota !== undefined) {
    if (typeof c.quota !== "object" || c.quota === null) {
      throw new ZError(`Config "quota" must be an object.`);
    }
    // Number.isFinite matters (issue #14 item 18): a NaN threshold passed the
    // old typeof/negative checks, and `remaining >= NaN` is always false -- the
    // quota guard would trip on EVERY call, sleeping or aborting forever.
    if (
      c.quota.threshold !== undefined &&
      (typeof c.quota.threshold !== "number" || !Number.isFinite(c.quota.threshold) || c.quota.threshold < 0)
    ) {
      throw new ZError(`Config "quota.threshold" must be a non-negative number.`);
    }
    if (c.quota.mode !== undefined && c.quota.mode !== "sleep" && c.quota.mode !== "abort") {
      throw new ZError(`Config "quota.mode" must be "sleep" or "abort", got ${JSON.stringify(c.quota.mode)}.`);
    }
  }

  // humanNeededPercent (issue #63): the mid-run breakdown notification's trip
  // threshold. `0` is a legitimate "disable" value (unlike maxLanes etc.), so
  // this is a bespoke non-negative-finite guard, not requirePositiveNumber.
  if (
    c.humanNeededPercent !== undefined &&
    (typeof c.humanNeededPercent !== "number" || !Number.isFinite(c.humanNeededPercent) || c.humanNeededPercent < 0)
  ) {
    throw new ZError(
      `Config "humanNeededPercent" must be a non-negative number (0 disables), got ${JSON.stringify(c.humanNeededPercent)}.`
    );
  }

  // notifications (#60): validated only when present (absent = off). The
  // discordWebhookUrl is a SECRET, so its error text names the field ONLY and
  // never echoes the value -- a pasted bare token or a leaked URL must not land
  // in a log line. This is the single enforcement point: z-setup writes through
  // it, loadConfig reads through it.
  if (c.notifications !== undefined) {
    const n = c.notifications;
    if (typeof n !== "object" || n === null) {
      throw new ZError(`Config "notifications" must be an object.`);
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
      if (typeof n.events !== "object" || n.events === null) {
        throw new ZError(`Config "notifications.events" must be an object of {event: boolean}.`);
      }
      for (const [k, v] of Object.entries(n.events)) {
        if (!(EVENT_KEYS as readonly string[]).includes(k)) {
          throw new ZError(
            `Config "notifications.events.${k}" is not a known event. Valid: ${EVENT_KEYS.join(", ")}`
          );
        }
        if (typeof v !== "boolean") {
          throw new ZError(`Config "notifications.events.${k}" must be a boolean.`);
        }
      }
    }
  }

  return c as BoardConfig;
}
