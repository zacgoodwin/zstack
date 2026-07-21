// The deterministic GraphQL half of /z-setup (child C3). The SKILL.md drives the
// interactive bits (preconditions, the epic-style decision, the manual workflow
// toggle); everything reproducible lives here: create-or-adopt a ProjectV2, drive
// its Status field to the canonical nine statuses, create the four custom fields,
// verify the result, and emit the BoardConfig that z-board reads.
//
// Same seam as lib/board.ts: the GraphQL call is injected (GraphQLExecutor) so
// every test runs on fixtures with zero network. Production reuses board.ts's
// ghExecutor (imported, not re-implemented) so board.ts stays the single file
// that shells out to the CLI -- the grep contract gate depends on that.
//
// Idempotence is structural, not a flag: readState -> diffState -> apply. A board
// that already matches the desired shape produces an empty action list, so a
// re-run plans (and executes) exactly zero mutations.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { handleCliError, parseFlags, requireFlag, str } from "./cli.ts";
import {
  BoardConfig,
  type BoardStatus,
  DEFAULT_EPIC_STYLE,
  DEFAULT_MAX_LANES,
  DEFAULT_QUOTA,
  DEFAULT_WATCHDOG_MINUTES,
  EpicStyle,
  FieldConfig,
  FieldDataType,
  configPath,
  ZError,
} from "./config.ts";
import {
  requirePositiveNumber,
  validateAdversarialMode,
  validateConfig,
  validateNotifications,
  validateQuota,
  validateStageModels,
} from "./config-schema.ts";
import { ghExecutor, type GraphQLData, type GraphQLExecutor } from "./board.ts";
import {
  type BoardShape,
  type BoardTemplate,
  type DesiredField,
  type TemplateOption,
  type TemplateView,
  DEFAULT_SHAPE,
  DEFAULT_TEMPLATE,
  deriveShape,
  loadBoardTemplate,
} from "./board-template.ts";

export { ZError } from "./config.ts";
export type { DesiredField } from "./board-template.ts";

// -- desired board shape (docs/user-guide/spec/PROCESS.md + issue #1) ---------
export const STATUS_FIELD_NAME = "Status";

// The board shape is data now (issue #20): the nine statuses and four custom
// fields live in z-setup/board-template.json, loaded + validated by
// lib/board-template.ts. These module constants expose the DEFAULT (packaged)
// shape so callers and the USAGE banner keep a zero-arg view; a `--template`
// override flows in as an explicit BoardShape (see SetupBoard, diffState). Order
// is the contract: STATUS_OPTIONS is the left-to-right column order, and
// diffState compares it as a sequence. BOARD_STATUSES (lib/config.ts) stays the
// canonical type the loader validates every template's status set against.
export const STATUS_OPTIONS: readonly BoardStatus[] = DEFAULT_SHAPE.statusOptions;

export const CUSTOM_FIELDS: DesiredField[] = DEFAULT_SHAPE.customFields;

// The desired option meta (name + color + description) for one field, for
// inlining into the create/update mutation. Status draws from statusMeta; every
// other single-select field from fieldMeta. An action referencing a field with
// no meta is a template/derivation bug, so it throws rather than emit a
// color-less literal.
function optionMetaFor(shape: BoardShape, fieldName: string): TemplateOption[] {
  if (fieldName === STATUS_FIELD_NAME) return shape.statusMeta;
  const meta = shape.fieldMeta[fieldName];
  if (!meta) throw new ZError(`Board template carries no option metadata for field "${fieldName}".`);
  return meta;
}

// -- observed board state ----------------------------------------------------
export interface OptionState {
  id: string;
  name: string;
}
export interface FieldState {
  id: string;
  name: string;
  dataType: FieldDataType;
  options?: OptionState[];
}
export interface ProjectState {
  id: string;
  number: number;
  title: string;
  fields: FieldState[];
}

// -- planned mutations -------------------------------------------------------
export type SetupAction =
  | { kind: "create-project"; title: string }
  | { kind: "set-status-options"; options: string[] }
  | { kind: "create-field"; name: string; dataType: FieldDataType; options?: string[] }
  | { kind: "set-field-options"; name: string; options: string[] };

function sameSequence(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// The whole idempotence contract in one pure function: given what exists and
// what should exist (the DEFAULT shape unless a `--template` override is passed),
// return the mutations to close the gap. Empty result = the board is already
// correct = re-run does nothing.
export function diffState(
  project: ProjectState | null,
  title: string,
  shape: BoardShape = DEFAULT_SHAPE
): SetupAction[] {
  const actions: SetupAction[] = [];

  if (!project) {
    // Fresh board: create it, then reconfigure its default Status field and add
    // every custom field. (A new ProjectV2 ships with Status = Todo/In
    // Progress/Done, never the canonical nine, so set-status-options always runs
    // on the create path.)
    actions.push({ kind: "create-project", title });
    actions.push({ kind: "set-status-options", options: [...shape.statusOptions] });
    for (const f of shape.customFields) {
      actions.push({ kind: "create-field", name: f.name, dataType: f.dataType, options: f.options });
    }
    return actions;
  }

  const status = project.fields.find((f) => f.name === STATUS_FIELD_NAME);
  if (!status) {
    throw new ZError(
      `Project #${project.number} "${project.title}" has no Status field; it is not a usable board.`
    );
  }
  const statusNames = (status.options ?? []).map((o) => o.name);
  if (!sameSequence(statusNames, shape.statusOptions)) {
    actions.push({ kind: "set-status-options", options: [...shape.statusOptions] });
  }

  for (const f of shape.customFields) {
    const existing = project.fields.find((pf) => pf.name === f.name);
    if (!existing) {
      actions.push({ kind: "create-field", name: f.name, dataType: f.dataType, options: f.options });
      continue;
    }
    if (f.dataType === "SINGLE_SELECT") {
      const cur = (existing.options ?? []).map((o) => o.name);
      if (!sameSequence(cur, f.options!)) {
        actions.push({ kind: "set-field-options", name: f.name, options: f.options! });
      }
    }
    // A pre-existing NUMBER field with the right name is left alone; a name
    // collision against a wrong dataType surfaces at verify() as a DRIFT line
    // rather than being silently "fixed" (GitHub can't retype a field in place).
  }
  return actions;
}

// -- verification (acceptance criterion 1: scripted, not eyeballs) -----------
export interface VerifyReport {
  ok: boolean;
  lines: string[];
}

export function verifyReport(project: ProjectState | null, shape: BoardShape = DEFAULT_SHAPE): VerifyReport {
  if (!project) return { ok: false, lines: ["Project not found. Run /z-setup first."] };

  const actions = diffState(project, project.title, shape);
  const lines: string[] = [];

  const status = project.fields.find((f) => f.name === STATUS_FIELD_NAME);
  const statusNames = (status?.options ?? []).map((o) => o.name);
  const missingStatus = shape.statusOptions.filter((s) => !statusNames.includes(s));
  const statusDrift = actions.some((a) => a.kind === "set-status-options");
  lines.push(
    `Status: ${statusDrift ? "DRIFT" : "OK"} (${statusNames.length}/${shape.statusOptions.length}` +
      `${missingStatus.length ? `, missing: ${missingStatus.join(", ")}` : ""})`
  );

  for (const df of shape.customFields) {
    const f = project.fields.find((pf) => pf.name === df.name);
    const drift = actions.some(
      (a) => (a.kind === "create-field" || a.kind === "set-field-options") && a.name === df.name
    );
    if (!f) {
      lines.push(`${df.name}: MISSING (absent)`);
      continue;
    }
    if (df.dataType === "SINGLE_SELECT") {
      const names = (f.options ?? []).map((o) => o.name);
      const miss = df.options!.filter((o) => !names.includes(o));
      lines.push(
        `${df.name}: ${drift ? "DRIFT" : "OK"} (single-select${miss.length ? `, missing: ${miss.join(", ")}` : ""})`
      );
    } else {
      const typeOk = f.dataType === df.dataType;
      lines.push(`${df.name}: ${typeOk ? "OK" : `DRIFT (type ${f.dataType}, want ${df.dataType})`} (number)`);
    }
  }

  return { ok: actions.length === 0, lines };
}

// -- GraphQL operations ------------------------------------------------------
// Single-select option lists come from the loaded board template, inlined as
// GraphQL literals rather than passed as variables: that keeps every runtime
// variable scalar. The name/description are JSON-escaped; `color` is a bare
// ProjectV2 enum token, safe to inline because the loader validated it against
// the fixed enum set (lib/board-template.ts VALID_OPTION_COLORS).
function optionLiterals(opts: TemplateOption[]): string {
  return opts
    .map((o) => `{name: ${JSON.stringify(o.name)}, color: ${o.color}, description: ${JSON.stringify(o.description)}}`)
    .join(", ");
}

const Q_OWNER_ID = `query OwnerId($login: String!) { repositoryOwner(login: $login) { id } }`;

const Q_REPO_ID = `query RepoId($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}`;

// Paginated (issue F8): a title match past page one would read as "absent" and
// apply() would create a DUPLICATE project, so a loud throw is not enough here
// -- the lookup must actually walk every page.
const Q_PROJECTS = `query Projects($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    projectsV2(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id number title }
    }
  }
}`;

const Q_PROJECT_BY_NUMBER = `query ProjectByNumber($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $number) { id number title }
  }
}`;

// Counts live items per option of ONE single-select field ($field), so the
// adopt guard can see which non-canonical options still hold items before they
// are wholesale-replaced (Status, Model, and Model Effort all get this check).
// Paginated: undercounting past 100 items would let the guard wave through a
// destructive adopt on a big board.
const Q_FIELD_USAGE = `query FieldUsage($project: ID!, $field: String!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

// Paginated (issue F8): a field past page one would read as missing, and apply()
// would try to create a DUPLICATE custom field.
const Q_PROJECT_FIELDS = `query ProjectFields($project: ID!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      id number title
      fields(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
    }
  }
}`;

const M_CREATE_PROJECT = `mutation CreateProject($owner: ID!, $title: String!, $repo: ID!) {
  createProjectV2(input: {ownerId: $owner, title: $title, repositoryId: $repo}) {
    projectV2 { id number title }
  }
}`;

const M_CREATE_NUMBER_FIELD = `mutation CreateNumberField($project: ID!, $name: String!) {
  createProjectV2Field(input: {projectId: $project, dataType: NUMBER, name: $name}) {
    projectV2Field { ... on ProjectV2FieldCommon { id name } }
  }
}`;

function mCreateSingleSelectField(opts: TemplateOption[]): string {
  return `mutation CreateSingleSelectField($project: ID!, $name: String!) {
  createProjectV2Field(input: {projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: [${optionLiterals(opts)}]}) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name } }
  }
}`;
}

function mUpdateFieldOptions(opts: TemplateOption[]): string {
  return `mutation UpdateFieldOptions($field: ID!) {
  updateProjectV2Field(input: {fieldId: $field, singleSelectOptions: [${optionLiterals(opts)}]}) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name } }
  }
}`;
}

// -- driver ------------------------------------------------------------------
export interface ProjectHeader {
  id: string;
  number: number;
  title: string;
}

export interface ApplyOptions {
  slug: string;
  title: string;
  projectNumber?: number; // adopt this exact project instead of searching by title
  // Only "milestones" is supported (issue #14 item 6): the literal type pins TS
  // callers, and apply() re-checks at runtime for plain-JS callers (F9).
  epicStyle?: "milestones";
  maxLanes?: number;
  watchdogMinutes?: number;
  force?: boolean; // adopt even when non-canonical single-select options still hold items
  // Override for where ~/.zstack lives (issue #97: buildConfig reads the prior
  // config.json from here to preserve hand-added optional fields). Tests pass
  // an isolated temp dir; production omits it and buildConfig falls back to
  // the real homedir(), matching writeConfig's own default.
  home?: string;
}

// A non-canonical single-select option that had items when it was replaced
// (--force). `field` names which field lost it (Status, Model, Model Effort).
export interface DroppedOption {
  field: string;
  name: string;
  count: number;
}

export interface ApplyResult {
  config: BoardConfig;
  actions: SetupAction[];
  created: boolean;
  dropped: DroppedOption[];
}

function optionMap(options: OptionState[] | undefined): Record<string, string> {
  return Object.fromEntries((options ?? []).map((o) => [o.name, o.id]));
}

export class SetupBoard {
  // `shape` is the DEFAULT (packaged) board shape unless a `--template` override
  // is supplied; every diff/verify/apply path on this instance reads it, so a
  // whole setup run honors exactly one shape.
  constructor(
    private exec: GraphQLExecutor,
    private shape: BoardShape = DEFAULT_SHAPE
  ) {}

  private async ownerId(login: string): Promise<string> {
    const data = await this.exec(Q_OWNER_ID, { login });
    const id = data.repositoryOwner?.id;
    if (!id) throw new ZError(`GitHub owner "${login}" not found.`);
    return id;
  }

  private async repoId(owner: string, repo: string): Promise<string> {
    const data = await this.exec(Q_REPO_ID, { owner, repo });
    const id = data.repository?.id;
    if (!id) throw new ZError(`Repository "${owner}/${repo}" not found.`);
    return id;
  }

  // Cursor-follows a GraphQL connection to exhaustion, with lib/board.ts's
  // loud-throw contract (F6): hasNextPage with a missing/empty endCursor, or a
  // cursor that repeats, throws instead of silently truncating or spinning.
  // Truncation here is never cosmetic: an undercounted FieldUsage waves a
  // destructive adopt through, and a missed Projects page creates a duplicate.
  // The page callback receives undefined on page one so callers can omit the
  // $after variable entirely (ghExecutor encodes every variable it is given).
  private async paginate<T>(
    what: string,
    page: (
      after: string | undefined
    ) => Promise<{ pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (T | null)[] } | null | undefined>
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (;;) {
      const conn = await page(after);
      for (const n of conn?.nodes ?? []) if (n != null) out.push(n);
      const info = conn?.pageInfo;
      if (!info?.hasNextPage) return out;
      const next = info.endCursor;
      if (typeof next !== "string" || next === "") {
        throw new ZError(
          `${what} advertises another page but returned no endCursor -- refusing to silently truncate.`
        );
      }
      if (next === after) {
        throw new ZError(
          `${what} pagination returned endCursor "${next}" twice in a row -- aborting instead of looping forever.`
        );
      }
      after = next;
    }
  }

  // Which project to work on. By explicit number (adopt), else by title match
  // among the repo's linked projects. null means "does not exist yet".
  async resolveHeader(
    owner: string,
    repo: string,
    opts: { number?: number; title: string }
  ): Promise<ProjectHeader | null> {
    if (opts.number !== undefined) {
      const data = await this.exec(Q_PROJECT_BY_NUMBER, { owner, repo, number: opts.number });
      const p = data.repository?.projectV2;
      return p ? { id: p.id, number: p.number, title: p.title } : null;
    }
    const nodes = await this.paginate<any>("Projects", async (after) => {
      const data = await this.exec(Q_PROJECTS, after ? { owner, repo, after } : { owner, repo });
      return data.repository?.projectsV2;
    });
    const match = nodes.find((n) => n.title === opts.title);
    return match ? { id: match.id, number: match.number, title: match.title } : null;
  }

  async readFields(projectId: string): Promise<ProjectState> {
    // The header (id/number/title) rides along on page one; only the fields
    // connection is followed across pages.
    let header: any;
    const fieldNodes = await this.paginate<any>("ProjectFields", async (after) => {
      const data = await this.exec(Q_PROJECT_FIELDS, after ? { project: projectId, after } : { project: projectId });
      if (header === undefined) header = data.node;
      return data.node?.fields;
    });
    return stateFromNode(header, fieldNodes);
  }

  // Item count per option name of one single-select field, across every page.
  private async fieldUsage(projectId: string, field: string): Promise<Record<string, number>> {
    const nodes = await this.paginate<any>(`FieldUsage("${field}")`, async (after) => {
      const data = await this.exec(
        Q_FIELD_USAGE,
        after ? { project: projectId, field, after } : { project: projectId, field }
      );
      return data.node?.items;
    });
    const counts: Record<string, number> = {};
    for (const n of nodes) {
      const name = n?.fieldValueByName?.name;
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
  }

  // For each field whose options are about to be replaced, count the items
  // still assigned to each to-be-deleted option. One FieldUsage sweep per field
  // (fieldValueByName takes exactly one name per query).
  private async populatedDrops(
    projectId: string,
    atRisk: { field: string; options: string[] }[]
  ): Promise<DroppedOption[]> {
    const dropped: DroppedOption[] = [];
    for (const r of atRisk) {
      const usage = await this.fieldUsage(projectId, r.field);
      for (const name of r.options) {
        const count = usage[name] ?? 0;
        if (count > 0) dropped.push({ field: r.field, name, count });
      }
    }
    return dropped;
  }

  // Reads the full state, or null when the project does not exist.
  async readState(
    owner: string,
    repo: string,
    opts: { number?: number; title: string }
  ): Promise<ProjectState | null> {
    const header = await this.resolveHeader(owner, repo, opts);
    if (!header) return null;
    return this.readFields(header.id);
  }

  // Reads live state and returns the mutations needed to reach the desired
  // shape. Zero mutations issued -- this is the "what would change" probe the
  // idempotence test asserts empty on an already-set-up board.
  async plan(owner: string, repo: string, opts: { number?: number; title: string }): Promise<SetupAction[]> {
    const state = await this.readState(owner, repo, opts);
    return diffState(state, opts.title, this.shape);
  }

  // Creates or adopts the project, executes exactly the planned mutations, then
  // re-reads and builds the validated BoardConfig. Never WRITES the filesystem
  // (see writeConfig); it does READ the prior config.json (issue #97, via
  // buildConfig) to preserve hand-added optional fields, tolerating an absent
  // or unreadable file, so it stays unit-testable with an isolated `opts.home`.
  async apply(owner: string, repo: string, opts: ApplyOptions): Promise<ApplyResult> {
    // F9: every user-supplied input is checked before the FIRST GraphQL call.
    // Validation used to live only in validateConfig AFTER the mutations, so a
    // bad --max-lanes mutated the board and then failed without writing config.
    validateApplyOptions(opts);
    const repositoryId = await this.repoId(owner, repo);

    let header = await this.resolveHeader(owner, repo, { number: opts.projectNumber, title: opts.title });
    const created = header === null;
    if (!header) {
      const ownerId = await this.ownerId(owner);
      const data = await this.exec(M_CREATE_PROJECT, { owner: ownerId, title: opts.title, repo: repositoryId });
      const p = data.createProjectV2?.projectV2;
      if (!p?.id) throw new ZError("createProjectV2 returned no project.");
      header = { id: p.id, number: p.number, title: p.title };
    }

    let state = await this.readFields(header.id);
    // Project now exists, so drop create-project; execute the rest against real
    // field ids from `state`.
    const actions = diffState(state, opts.title, this.shape).filter((a) => a.kind !== "create-project");

    // Destructive-adopt guard (issue #14 item 5, generalized by F7 to EVERY
    // single-select replace: Status, Model, Model Effort). Replacing a field's
    // options deletes every non-canonical option, and items assigned to a
    // deleted option silently lose that field's value. On an adopted board
    // (never one we just created: its default options hold zero items) refuse
    // before ANY mutation runs, unless --force; --force still surfaces what is
    // dropped, per field.
    const replaces: { field: string; desired: string[] }[] = [];
    if (!created) {
      for (const a of actions) {
        if (a.kind === "set-status-options") replaces.push({ field: STATUS_FIELD_NAME, desired: a.options });
        else if (a.kind === "set-field-options") replaces.push({ field: a.name, desired: a.options });
      }
    }
    // Per replaced field: the existing options the replace would delete.
    const atRisk = replaces
      .map((r) => ({
        field: r.field,
        options: (state.fields.find((f) => f.name === r.field)?.options ?? [])
          .map((o) => o.name)
          .filter((n) => !r.desired.includes(n)),
      }))
      .filter((r) => r.options.length > 0);

    let dropped: DroppedOption[] = [];
    if (atRisk.length) {
      dropped = await this.populatedDrops(header.id, atRisk);
      if (dropped.length && !opts.force) {
        const detail = dropped.map((d) => `  ${d.field} "${d.name}": ${d.count} item(s)`).join("\n");
        throw new ZError(
          `Refusing to adopt project #${header.number} "${header.title}": replacing single-select ` +
            `options would delete non-canonical options that still have items assigned ` +
            `(those items silently lose that field's value):\n${detail}\n` +
            `Re-run with --force to drop them anyway.`
        );
      }

      // TOCTOU mitigation (F10). The Projects API has no conditional mutation,
      // so check-then-replace can never be atomic client-side. Re-scanning here
      // shrinks the unguarded window from "scan -> human --force confirmation
      // -> mutation" (minutes) to the gap between this read and the
      // UpdateFieldOptions calls below (milliseconds). That residual window is
      // the known ceiling: an item assigned inside it still loses its value
      // silently -- SKILL.md tells the operator to run adopt on a quiescent
      // board. Any option populated since the report above was produced is NOT
      // covered by what the user consented to, so it refuses even under --force.
      const recheck = await this.populatedDrops(header.id, atRisk);
      const reported = new Set(dropped.map((d) => JSON.stringify([d.field, d.name])));
      const fresh = recheck.filter((d) => !reported.has(JSON.stringify([d.field, d.name])));
      if (fresh.length) {
        const detail = fresh.map((d) => `  ${d.field} "${d.name}": ${d.count} item(s)`).join("\n");
        throw new ZError(
          `Refusing to adopt project #${header.number} "${header.title}": items were assigned to ` +
            `non-canonical options while setup was running -- these were NOT in the report above:\n` +
            `${detail}\nThe board is not quiescent; stop other writers and re-run.`
        );
      }
      dropped = recheck; // report the counts that are actually destroyed
    }

    for (const a of actions) {
      if (a.kind === "set-status-options") {
        const fieldId = requireFieldId(state, STATUS_FIELD_NAME);
        await this.exec(mUpdateFieldOptions(optionMetaFor(this.shape, STATUS_FIELD_NAME)), { field: fieldId });
      } else if (a.kind === "create-field") {
        if (a.dataType === "SINGLE_SELECT") {
          await this.exec(mCreateSingleSelectField(optionMetaFor(this.shape, a.name)), { project: header.id, name: a.name });
        } else {
          await this.exec(M_CREATE_NUMBER_FIELD, { project: header.id, name: a.name });
        }
      } else if (a.kind === "set-field-options") {
        const fieldId = requireFieldId(state, a.name);
        await this.exec(mUpdateFieldOptions(optionMetaFor(this.shape, a.name)), { field: fieldId });
      }
    }

    // Re-read only if we changed something; a no-op run reuses the state it read.
    const finalState = actions.length ? await this.readFields(header.id) : state;
    const config = buildConfig(finalState, { owner, repo, repositoryId, ...opts }, this.shape, created);
    validateConfig(config);
    return { config, actions, created, dropped };
  }

  async verify(owner: string, repo: string, opts: { number?: number; title: string }): Promise<VerifyReport> {
    const state = await this.readState(owner, repo, opts);
    return verifyReport(state, this.shape);
  }
}

// fieldNodes arrive separately from the header node because readFields
// accumulates them across pages (F8).
function stateFromNode(node: any, fieldNodes: any[]): ProjectState {
  if (!node || node.id === undefined) throw new ZError("Project not found (node returned null).");
  const fields: FieldState[] = fieldNodes
    .filter((f: any) => f && f.name && f.dataType)
    .map((f: any) => ({
      id: f.id,
      name: f.name,
      dataType: f.dataType as FieldDataType,
      options: f.options ? f.options.map((o: any) => ({ id: o.id, name: o.name })) : undefined,
    }));
  return { id: node.id, number: node.number, title: node.title, fields };
}

// F9 pre-flight: apply()'s defense against plain-JS callers (the ApplyOptions
// literal types cover TS only). Same guards -- and error text -- as the config
// these values become, but run BEFORE the first GraphQL op so a bad input can
// never leave the board half-mutated with no config written.
function validateApplyOptions(opts: ApplyOptions): void {
  if (typeof opts.slug !== "string" || !opts.slug) {
    throw new ZError(`Config "slug" must be a non-empty string.`);
  }
  toEpicStyle(opts.epicStyle); // rejects "issue-type" and any other non-"milestones" value
  requirePositiveNumber("maxLanes", opts.maxLanes);
  requirePositiveNumber("watchdogMinutes", opts.watchdogMinutes);
  if (opts.projectNumber !== undefined && !Number.isInteger(opts.projectNumber)) {
    throw new ZError(`"projectNumber" must be an integer, got ${JSON.stringify(opts.projectNumber)}.`);
  }
}

function requireFieldId(state: ProjectState, name: string): string {
  const f = state.fields.find((x) => x.name === name);
  if (!f) throw new ZError(`Field "${name}" not found on project "${state.title}" after setup.`);
  return f.id;
}

// The four optional fields a re-apply must never silently reset (issue #97): a
// user who hand-edits one of these into config.json (stageModels, issue #82;
// or quota/notifications/adversarialMode) must have it survive the next
// board-shape-drift re-apply, since buildConfig otherwise assembles the whole
// config fresh from the live board every time.
//
// Reads the RAW prior file rather than lib/config.ts's loadConfig(): loadConfig
// fills quota and adversarialMode with defaults even when the key is absent
// from disk (by design, for every other caller), which would inject a key that
// was never there and break the byte-identical no-drift contract (a re-apply
// over a config with none of these four fields must reproduce today's output
// exactly). Tolerates a missing or unparsable prior file -- first-time setup
// and a corrupt hand-edit both fall back to "nothing to preserve", never a
// crash.
//
// Each field is ALSO shape-validated with config-schema.ts's per-field
// validators before being preserved (issue #97 review finding 1): apply()
// runs the board's GraphQL mutations (lines 580-594) before buildConfig ->
// validateConfig ever sees this value, so a validly-parsed but wrong-shape
// hand-edit (e.g. `{"quota":"banana"}`) must not reach validateConfig and
// throw AFTER the board already changed -- the config.json would never get
// written and the live board and file would go out of sync. A field that
// fails its own shape check falls back to "nothing to preserve for that
// field" (same tolerant treatment as a missing/unparsable file), leaving the
// other three fields' preservation unaffected.
type PreservedOptionalFields = Partial<
  Pick<BoardConfig, "stageModels" | "quota" | "notifications" | "adversarialMode">
>;

function priorOptionalFields(slug: string, home: string): PreservedOptionalFields {
  const path = configPath(slug, home);
  if (!existsSync(path)) return {};
  let raw: Partial<BoardConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const preserved: PreservedOptionalFields = {};
  const take = <K extends keyof PreservedOptionalFields>(key: K, validate: (v: unknown) => void): void => {
    const value = raw[key];
    if (value === undefined) return;
    try {
      validate(value);
    } catch {
      return; // wrong-shape hand-edit: nothing to preserve for this field
    }
    preserved[key] = value as PreservedOptionalFields[K];
  };
  take("stageModels", validateStageModels);
  take("quota", validateQuota);
  take("notifications", validateNotifications);
  take("adversarialMode", validateAdversarialMode);
  return preserved;
}

function buildConfig(
  state: ProjectState,
  ctx: { owner: string; repo: string; repositoryId: string } & ApplyOptions,
  shape: BoardShape = DEFAULT_SHAPE,
  // Issue #82: stageModels' pack default ({merge: "haiku"}) is written ONLY
  // for a brand-new project (created === true). An adopted/pre-existing
  // project's config is left exactly as buildConfig would otherwise produce
  // it -- no stageModels key at all -- so a re-run against an already-set-up
  // board never injects (or silently drops) the knob; a user who wants it on
  // an existing project adds it to config.json by hand (documented). That
  // hand-added value, once on disk, then wins over this default on every
  // later re-apply regardless of `created` (see priorOptionalFields, #97).
  created = false
): BoardConfig {
  const status = state.fields.find((f) => f.name === STATUS_FIELD_NAME);
  if (!status) throw new ZError(`Status field missing on "${state.title}" after setup.`);

  const fields: Record<string, FieldConfig> = {};
  for (const df of shape.customFields) {
    const f = state.fields.find((sf) => sf.name === df.name);
    if (!f) throw new ZError(`Field "${df.name}" missing on "${state.title}" after setup.`);
    fields[df.name] =
      df.dataType === "SINGLE_SELECT"
        ? { id: f.id, dataType: "SINGLE_SELECT", options: optionMap(f.options) }
        : { id: f.id, dataType: df.dataType };
  }

  const prior = priorOptionalFields(ctx.slug, ctx.home ?? homedir());

  return {
    slug: ctx.slug,
    owner: ctx.owner,
    repo: ctx.repo,
    projectNumber: state.number,
    projectId: state.id,
    repositoryId: ctx.repositoryId,
    statusField: { id: status.id, dataType: "SINGLE_SELECT", options: optionMap(status.options) },
    fields,
    epicStyle: ctx.epicStyle ?? DEFAULT_EPIC_STYLE,
    maxLanes: ctx.maxLanes ?? DEFAULT_MAX_LANES,
    watchdogMinutes: ctx.watchdogMinutes ?? DEFAULT_WATCHDOG_MINUTES,
    quota: { ...DEFAULT_QUOTA },
    ...(created ? { stageModels: { merge: "haiku" } } : {}),
    ...prior, // issue #97: a hand-added value in the prior config.json wins over every default above
  };
}

// Writes the validated config to ~/.zstack/projects/<slug>/config.json. Split
// out of apply() so apply stays fs-free and testable; main() calls both.
export function writeConfig(config: BoardConfig, home: string = homedir()): string {
  validateConfig(config);
  const path = configPath(config.slug, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `z-setup-board <command> [flags]

  plan   --owner O --repo R --title T [--project-number N] [--template FILE]
         print the mutations needed to reach the board shape (zero writes)
  apply  --owner O --repo R --slug S --title T [--project-number N] [--force]
         [--epic-style milestones] [--max-lanes 3] [--watchdog-minutes 10] [--template FILE]
         create/adopt the project, run the mutations, write config.json
         (adopting a board whose non-canonical Status options still hold items
         refuses and lists them unless --force is given)
  verify --owner O --repo R [--title T | --project-number N] [--template FILE]
         check the live board against the shape's statuses + fields; non-zero on drift

  --template FILE  use a board-shape template instead of the packaged default
                   (z-setup/board-template.json). The status set must equal the
                   canonical nine and the four required fields (Model, Model
                   Effort, Estimate, Actual) must be present, or it is refused.

Statuses: ${STATUS_OPTIONS.join(", ")}
Fields:   ${CUSTOM_FIELDS.map((f) => f.name).join(", ")}

Views (${DEFAULT_TEMPLATE.views.length}) are described in the template but GitHub's API
cannot create them; apply prints them as manual steps.`;

// GitHub's ProjectV2 GraphQL API exposes NO view-creation mutation (probed at
// build time, 2026-07: 29 ProjectV2 mutations -- createProjectV2Field,
// updateProjectV2Field, ... -- none for views; ProjectV2View is a read-only
// object). So the template's views cannot be created programmatically. Rather
// than silently drop them (issue #20 AC5), setup prints each as an explicit
// manual step. If GitHub ever ships a createProjectV2View mutation, wire it into
// apply() and gate this block on its absence.
export function renderViewsBlock(views: TemplateView[]): string {
  if (!views.length) return "";
  const lines = [
    "",
    "Board views (manual -- GitHub's API cannot create ProjectV2 views):",
    "  On github.com open the project, click + beside the view tabs, and add:",
  ];
  for (const v of views) {
    const bits = [`layout: ${v.layout}`];
    if (v.groupBy) bits.push(`group by: ${v.groupBy}`);
    if (v.filter) bits.push(`filter: ${v.filter}`);
    lines.push(`  - "${v.name}" (${bits.join(", ")})${v.description ? ` -- ${v.description}` : ""}`);
  }
  return lines.join("\n");
}

// Exported for the gate test: rejecting "issue-type" here keeps the CLI from
// ever calling GraphQL with a config the loop cannot act on (issue #14 item 6).
// Returns the supported literal, matching ApplyOptions.epicStyle (F9).
export function toEpicStyle(v: string | undefined): "milestones" | undefined {
  if (v === undefined) return undefined;
  if (v === "issue-type") {
    throw new ZError(
      `--epic-style "issue-type" is not yet supported (no sub-issue create path exists yet; issue #14). Use "milestones".`
    );
  }
  if (v !== "milestones") {
    throw new ZError(`--epic-style must be "milestones", got "${v}".`);
  }
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!["plan", "apply", "verify"].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }

  try {
    const { flags } = parseFlags(argv.slice(1), ["force"]);
    const owner = requireFlag(flags, "owner");
    const repo = requireFlag(flags, "repo");
    const projectNumberFlag = str(flags, "project-number");
    const number = projectNumberFlag ? Number(projectNumberFlag) : undefined;
    if (number !== undefined && !Number.isInteger(number)) {
      throw new ZError(`--project-number must be an integer, got "${projectNumberFlag}".`);
    }
    // Board shape: the packaged default unless --template overrides it. Loaded +
    // validated up front, before the first GraphQL op, so a bad template refuses
    // without mutating anything.
    const templatePath = str(flags, "template");
    const template: BoardTemplate = templatePath ? loadBoardTemplate(templatePath) : DEFAULT_TEMPLATE;
    const shape = templatePath ? deriveShape(template) : DEFAULT_SHAPE;
    const setup = new SetupBoard(ghExecutor(), shape);

    switch (cmd) {
      case "plan": {
        const title = requireFlag(flags, "title");
        const actions = await setup.plan(owner, repo, { number, title });
        console.log(JSON.stringify(actions, null, 2));
        console.log(
          actions.length
            ? `\n${actions.length} mutation(s) needed.`
            : "\nBoard already matches the desired shape; nothing to do."
        );
        const views = renderViewsBlock(template.views);
        if (views) console.log(views);
        return 0;
      }
      case "apply": {
        const slug = requireFlag(flags, "slug");
        const title = requireFlag(flags, "title");
        const maxLanes = str(flags, "max-lanes");
        const watchdogMinutes = str(flags, "watchdog-minutes");
        const result = await setup.apply(owner, repo, {
          slug,
          title,
          projectNumber: number,
          epicStyle: toEpicStyle(str(flags, "epic-style")),
          maxLanes: maxLanes ? Number(maxLanes) : undefined,
          watchdogMinutes: watchdogMinutes ? Number(watchdogMinutes) : undefined,
          force: flags["force"] === true,
        });
        const path = writeConfig(result.config);
        console.log(
          `${result.created ? "Created" : "Adopted"} project #${result.config.projectNumber} ` +
            `"${result.config.projectId}" with ${result.actions.length} mutation(s).`
        );
        if (result.dropped.length) {
          console.log(
            "--force dropped non-canonical options that had items: " +
              result.dropped.map((d) => `${d.field} "${d.name}" (${d.count} item(s))`).join(", ")
          );
        }
        console.log(`Wrote ${path}`);
        const views = renderViewsBlock(template.views);
        if (views) console.log(views);
        return 0;
      }
      case "verify": {
        const title = str(flags, "title");
        if (number === undefined && !title) {
          throw new ZError("verify needs --title or --project-number.");
        }
        const report = await setup.verify(owner, repo, { number, title: title ?? "" });
        for (const line of report.lines) console.log(line);
        console.log(report.ok ? "\nVERIFIED: board matches the contract." : "\nDRIFT: board does not match the contract.");
        return report.ok ? 0 : 1;
      }
      default:
        console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
