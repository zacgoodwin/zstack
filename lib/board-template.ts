// The board shape as data (issue #20). The nine statuses and four custom fields
// /z-setup creates used to be hardcoded in lib/setup-board.ts; they now live in
// the shipped z-setup/board-template.json, loaded and validated here. This is
// the seam that lets a repo ship a `--template <file>` override without touching
// code, while the loader still refuses any template the loop's state machine and
// z-tools cannot drive.
//
// Hand-rolled guards, same pattern as lib/config-schema.ts (ponytail rung 1: the
// shape is small and fixed, a dozen guards beat a schema-library dependency).
// Every rejection is a ZError naming the exact path, so a hand-broken template
// fails loudly at load -- before any board mutation is planned -- rather than as
// a confusing GraphQL error mid-setup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_STATUSES, type BoardStatus, type FieldDataType, ZError } from "./config.ts";

// One single-select option (a status is modeled as one too): the name the loop
// uses, plus the GitHub-side cosmetics. `color` is a bare ProjectV2 enum token
// inlined into the create mutation, so it is validated against the fixed enum
// set -- never free text -- and `description` is JSON-escaped when emitted.
export interface TemplateOption {
  name: string;
  color: string;
  description: string;
}

export interface TemplateField {
  name: string;
  dataType: FieldDataType;
  options?: TemplateOption[]; // required for SINGLE_SELECT, absent otherwise
}

// A board view. GitHub's GraphQL API has no view-creation mutation (probed at
// build time, 2026-07: 29 ProjectV2 mutations, none for views; ProjectV2View is
// read-only), so views are validated shape-only and rendered as manual setup
// steps by lib/setup-board.ts -- never silently dropped (issue #20 AC5).
export interface TemplateView {
  name: string;
  layout: string;
  groupBy?: string;
  filter?: string;
  description?: string;
}

export interface BoardTemplate {
  statuses: TemplateOption[];
  fields: TemplateField[];
  views: TemplateView[];
}

// The create/diff view of a field: option NAMES only (order = column order). The
// GraphQL-literal colors/descriptions ride in BoardShape.statusMeta/fieldMeta so
// diffState and its tests keep comparing plain name sequences.
export interface DesiredField {
  name: string;
  dataType: FieldDataType;
  options?: string[];
}

// The validated template projected into the two views setup-board.ts consumes:
// the name sequences diffState/verifyReport compare, and the full option meta the
// create/update mutations inline.
export interface BoardShape {
  statusOptions: BoardStatus[];
  customFields: DesiredField[];
  statusMeta: TemplateOption[];
  fieldMeta: Record<string, TemplateOption[]>;
  views: TemplateView[];
}

// GitHub's ProjectV2SingleSelectFieldOptionColor enum (the only colors a
// single-select option may carry). Matches the palette the old position-cycling
// emitted, so a color is inlined as a bare enum token safely.
const VALID_OPTION_COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PURPLE", "PINK"];
// The field dataTypes /z-setup can actually CREATE. FieldDataType (lib/config.ts)
// also carries "TEXT" -- real for reading/writing GitHub's built-in Title/Notes
// fields via lib/board.ts -- but lib/setup-board.ts's create loop only branches
// SINGLE_SELECT vs the NUMBER mutation, so a template "TEXT" field would be
// silently created as NUMBER and verify would report DRIFT forever. Refuse it
// here at load instead (issue #20 follow-up): a template may only ask for a type
// setup can build.
const DATA_TYPES: FieldDataType[] = ["SINGLE_SELECT", "NUMBER"];
// GitHub's ProjectV2 view layouts.
const VALID_VIEW_LAYOUTS = ["board", "table", "roadmap"];

// The four custom fields the loop and z-tools hard-depend on. A template that
// drops or renames any of them yields a board the loop cannot drive, so the
// loader refuses it -- naming the field AND the dependency (issue #20 AC3) --
// before setup plans a single mutation.
const REQUIRED_FIELDS: { name: string; dataType: FieldDataType; why: string }[] = [
  { name: "Model", dataType: "SINGLE_SELECT", why: "the model router reads it to pick the execution model" },
  { name: "Model Effort", dataType: "SINGLE_SELECT", why: "the model router reads it to pick the reasoning effort" },
  { name: "Estimate", dataType: "NUMBER", why: "z-estimate writes the dollar estimate here" },
  { name: "Actual", dataType: "NUMBER", why: "z-cost writes the measured dollar cost here" },
];

export const DEFAULT_TEMPLATE_PATH = join(import.meta.dir, "..", "z-setup", "board-template.json");

function requireNonEmptyString(path: string, v: unknown): string {
  if (typeof v !== "string" || !v) {
    throw new ZError(`Board template "${path}" must be a non-empty string, got ${JSON.stringify(v)}.`);
  }
  return v;
}

// Validates and normalizes one option (or status). `description` is optional in
// the file and defaults to "" so a hand-written override need not spell it out.
function validateOption(path: string, o: unknown): TemplateOption {
  if (typeof o !== "object" || o === null) {
    throw new ZError(`Board template "${path}" must be an object.`);
  }
  const opt = o as Record<string, unknown>;
  const name = requireNonEmptyString(`${path}.name`, opt.name);
  const color = requireNonEmptyString(`${path}.color`, opt.color);
  if (!VALID_OPTION_COLORS.includes(color)) {
    throw new ZError(
      `Board template "${path}.color" must be one of ${VALID_OPTION_COLORS.join(", ")}, got ${JSON.stringify(color)}.`
    );
  }
  if (opt.description !== undefined && typeof opt.description !== "string") {
    throw new ZError(`Board template "${path}.description" must be a string when present.`);
  }
  return { name, color, description: (opt.description as string | undefined) ?? "" };
}

function validateOptionList(path: string, raw: unknown): TemplateOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ZError(`Board template "${path}" must be a non-empty array.`);
  }
  const options = raw.map((o, i) => validateOption(`${path}[${i}]`, o));
  const names = options.map((o) => o.name);
  const dup = firstDuplicate(names);
  if (dup) throw new ZError(`Board template "${path}" has a duplicate name "${dup}"; option names must be unique.`);
  return options;
}

function validateField(path: string, f: unknown): TemplateField {
  if (typeof f !== "object" || f === null) {
    throw new ZError(`Board template "${path}" must be an object.`);
  }
  const field = f as Record<string, unknown>;
  const name = requireNonEmptyString(`${path}.name`, field.name);
  const dataType = field.dataType;
  if (typeof dataType !== "string" || !DATA_TYPES.includes(dataType as FieldDataType)) {
    throw new ZError(
      `Board template field "${name}" (${path}.dataType) must be one of ${DATA_TYPES.join(", ")}, ` +
        `got ${JSON.stringify(dataType)}; /z-setup can only create those field types.`
    );
  }
  if (dataType === "SINGLE_SELECT") {
    return { name, dataType, options: validateOptionList(`${path}.options`, field.options) };
  }
  if (field.options !== undefined) {
    throw new ZError(`Board template "${path}.options" is only valid for a SINGLE_SELECT field, not ${dataType}.`);
  }
  return { name, dataType: dataType as FieldDataType };
}

function validateView(path: string, v: unknown): TemplateView {
  if (typeof v !== "object" || v === null) {
    throw new ZError(`Board template "${path}" must be an object.`);
  }
  const view = v as Record<string, unknown>;
  const name = requireNonEmptyString(`${path}.name`, view.name);
  const layout = requireNonEmptyString(`${path}.layout`, view.layout);
  if (!VALID_VIEW_LAYOUTS.includes(layout)) {
    throw new ZError(
      `Board template "${path}.layout" must be one of ${VALID_VIEW_LAYOUTS.join(", ")}, got ${JSON.stringify(layout)}.`
    );
  }
  for (const k of ["groupBy", "filter", "description"] as const) {
    if (view[k] !== undefined && typeof view[k] !== "string") {
      throw new ZError(`Board template "${path}.${k}" must be a string when present.`);
    }
  }
  return {
    name,
    layout,
    groupBy: view.groupBy as string | undefined,
    filter: view.filter as string | undefined,
    description: view.description as string | undefined,
  };
}

// n <= 9 here (the status set, or one field's options), so indexOf beats a Set.
const firstDuplicate = (names: string[]): string | undefined =>
  names.find((n, i) => names.indexOf(n) !== i);

// Throws a ZError naming the first bad path; returns the normalized template on
// success. The status set must EQUAL lib/config.ts BOARD_STATUSES (no missing,
// no extras -- extra/renamed statuses are future work) and the four required
// fields must be present with their exact dataTypes.
export function validateBoardTemplate(raw: unknown): BoardTemplate {
  if (typeof raw !== "object" || raw === null) {
    throw new ZError("Board template must be a JSON object.");
  }
  const t = raw as Record<string, unknown>;

  if (!Array.isArray(t.statuses) || t.statuses.length === 0) {
    throw new ZError(`Board template "statuses" must be a non-empty array.`);
  }
  const statuses = t.statuses.map((s, i) => validateOption(`statuses[${i}]`, s));
  const statusNames = statuses.map((s) => s.name);
  const dupStatus = firstDuplicate(statusNames);
  if (dupStatus) {
    throw new ZError(`Board template has a duplicate status "${dupStatus}"; status names must be unique.`);
  }
  const canon = new Set<string>(BOARD_STATUSES);
  const got = new Set(statusNames);
  const missing = BOARD_STATUSES.filter((s) => !got.has(s));
  const extra = statusNames.filter((s) => !canon.has(s));
  if (missing.length || extra.length) {
    throw new ZError(
      `Board template statuses must equal the canonical set (lib/config.ts BOARD_STATUSES); the loop's ` +
        `state machine only knows these nine (${BOARD_STATUSES.join(", ")}). ` +
        `${missing.length ? `missing: ${missing.join(", ")}. ` : ""}` +
        `${extra.length ? `unsupported extras: ${extra.join(", ")}. ` : ""}` +
        `Extra or renamed statuses are future work.`
    );
  }

  if (!Array.isArray(t.fields) || t.fields.length === 0) {
    throw new ZError(`Board template "fields" must be a non-empty array.`);
  }
  const fields = t.fields.map((f, i) => validateField(`fields[${i}]`, f));
  const dupField = firstDuplicate(fields.map((f) => f.name));
  if (dupField) {
    throw new ZError(`Board template has a duplicate field "${dupField}"; field names must be unique.`);
  }
  for (const req of REQUIRED_FIELDS) {
    const f = fields.find((x) => x.name === req.name);
    if (!f) {
      throw new ZError(
        `Board template is missing the required field "${req.name}". The zstack loop hard-depends on it ` +
          `(${req.why}); refusing a template that drops or renames it.`
      );
    }
    if (f.dataType !== req.dataType) {
      throw new ZError(
        `Board template field "${req.name}" must be dataType ${req.dataType} (the loop hard-depends on it: ` +
          `${req.why}); got ${f.dataType}.`
      );
    }
  }

  // Views default to an empty list; when present each is shape-validated.
  const rawViews = t.views ?? [];
  if (!Array.isArray(rawViews)) {
    throw new ZError(`Board template "views" must be an array.`);
  }
  const views = rawViews.map((v, i) => validateView(`views[${i}]`, v));
  const dupView = firstDuplicate(views.map((v) => v.name));
  if (dupView) {
    throw new ZError(`Board template has a duplicate view "${dupView}"; view names must be unique.`);
  }

  return { statuses, fields, views };
}

// Reads + validates a board template. Defaults to the packaged shipped file. A
// read or JSON-parse failure becomes a ZError naming the path, never a raw
// SyntaxError (which main() would rethrow as a bug).
export function loadBoardTemplate(path: string = DEFAULT_TEMPLATE_PATH): BoardTemplate {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ZError(`Cannot read board template at ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ZError(`Board template at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  try {
    return validateBoardTemplate(raw);
  } catch (e) {
    if (e instanceof ZError) throw new ZError(`Board template at ${path} is invalid: ${e.message}`);
    throw e;
  }
}

// Projects a validated template into the shape setup-board.ts consumes.
export function deriveShape(template: BoardTemplate): BoardShape {
  const fieldMeta: Record<string, TemplateOption[]> = {};
  for (const f of template.fields) {
    if (f.options) fieldMeta[f.name] = f.options;
  }
  return {
    statusOptions: template.statuses.map((s) => s.name) as BoardStatus[],
    customFields: template.fields.map((f) => ({
      name: f.name,
      dataType: f.dataType,
      options: f.options?.map((o) => o.name),
    })),
    statusMeta: template.statuses,
    fieldMeta,
    views: template.views,
  };
}

// The packaged default, loaded once at import (a broken shipped template is a
// hard invariant failure -- fail loudly rather than run on a phantom shape).
export const DEFAULT_TEMPLATE: BoardTemplate = loadBoardTemplate();
export const DEFAULT_SHAPE: BoardShape = deriveShape(DEFAULT_TEMPLATE);
