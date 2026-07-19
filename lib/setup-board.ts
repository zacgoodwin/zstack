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
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  BoardConfig,
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
import { validateConfig } from "./config-schema.ts";
import { ghExecutor, type GraphQLData, type GraphQLExecutor } from "./board.ts";

export { ZError } from "./config.ts";

// -- desired board shape (references/PROCESS.md + issue #1) -------------------
export const STATUS_FIELD_NAME = "Status";

// Canonical board columns, in order. Order is the contract: it's the left-to-
// right column order on the board, and diffState compares it as a sequence.
export const STATUS_OPTIONS = [
  "Backlog",
  "Ready",
  "Questions",
  "Building",
  "QA",
  "Review",
  "Blocked",
  "Skipped",
  "Done",
] as const;

export interface DesiredField {
  name: string;
  dataType: FieldDataType;
  options?: string[]; // single-select only, in order
}

export const CUSTOM_FIELDS: DesiredField[] = [
  { name: "Model", dataType: "SINGLE_SELECT", options: ["haiku", "sonnet", "opus", "fable"] },
  { name: "Model Effort", dataType: "SINGLE_SELECT", options: ["low", "medium", "high", "xhigh"] },
  { name: "Estimate", dataType: "NUMBER" },
  { name: "Actual", dataType: "NUMBER" },
];

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
// what should exist, return the mutations to close the gap. Empty result = the
// board is already correct = re-run does nothing.
export function diffState(project: ProjectState | null, title: string): SetupAction[] {
  const actions: SetupAction[] = [];

  if (!project) {
    // Fresh board: create it, then reconfigure its default Status field and add
    // every custom field. (A new ProjectV2 ships with Status = Todo/In
    // Progress/Done, never the canonical nine, so set-status-options always runs
    // on the create path.)
    actions.push({ kind: "create-project", title });
    actions.push({ kind: "set-status-options", options: [...STATUS_OPTIONS] });
    for (const f of CUSTOM_FIELDS) {
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
  if (!sameSequence(statusNames, STATUS_OPTIONS)) {
    actions.push({ kind: "set-status-options", options: [...STATUS_OPTIONS] });
  }

  for (const f of CUSTOM_FIELDS) {
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

export function verifyReport(project: ProjectState | null): VerifyReport {
  if (!project) return { ok: false, lines: ["Project not found. Run /z-setup first."] };

  const actions = diffState(project, project.title);
  const lines: string[] = [];

  const status = project.fields.find((f) => f.name === STATUS_FIELD_NAME);
  const statusNames = (status?.options ?? []).map((o) => o.name);
  const missingStatus = STATUS_OPTIONS.filter((s) => !statusNames.includes(s));
  const statusDrift = actions.some((a) => a.kind === "set-status-options");
  lines.push(
    `Status: ${statusDrift ? "DRIFT" : "OK"} (${statusNames.length}/${STATUS_OPTIONS.length}` +
      `${missingStatus.length ? `, missing: ${missingStatus.join(", ")}` : ""})`
  );

  for (const df of CUSTOM_FIELDS) {
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
// Single-select option lists are our own fixed constants, so they are inlined as
// GraphQL literals rather than passed as variables: that keeps every runtime
// variable scalar, which is exactly what board.ts's ghExecutor (-f/-F only) can
// encode. JSON.stringify escapes the (controlled) name safely; color/description
// are literal enum/string tokens.
const COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PURPLE", "PINK"];

function optionLiterals(options: string[]): string {
  return options
    .map((name, i) => `{name: ${JSON.stringify(name)}, color: ${COLORS[i % COLORS.length]}, description: ""}`)
    .join(", ");
}

const Q_OWNER_ID = `query OwnerId($login: String!) { repositoryOwner(login: $login) { id } }`;

const Q_REPO_ID = `query RepoId($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}`;

const Q_PROJECTS = `query Projects($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    projectsV2(first: 50) { nodes { id number title } }
  }
}`;

const Q_PROJECT_BY_NUMBER = `query ProjectByNumber($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $number) { id number title }
  }
}`;

// Counts live items per Status option so the adopt guard can see which
// non-canonical options still hold items before they are wholesale-replaced.
// Paginated: undercounting past 100 items would let the guard wave through a
// destructive adopt on a big board.
const Q_STATUS_USAGE = `query StatusUsage($project: ID!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

const Q_PROJECT_FIELDS = `query ProjectFields($project: ID!) {
  node(id: $project) {
    ... on ProjectV2 {
      id number title
      fields(first: 50) {
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

function mCreateSingleSelectField(options: string[]): string {
  return `mutation CreateSingleSelectField($project: ID!, $name: String!) {
  createProjectV2Field(input: {projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: [${optionLiterals(options)}]}) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name } }
  }
}`;
}

function mUpdateFieldOptions(options: string[]): string {
  return `mutation UpdateFieldOptions($field: ID!) {
  updateProjectV2Field(input: {fieldId: $field, singleSelectOptions: [${optionLiterals(options)}]}) {
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
  epicStyle?: EpicStyle;
  maxLanes?: number;
  watchdogMinutes?: number;
  force?: boolean; // adopt even when non-canonical Status options still hold items
}

// A non-canonical Status option that had items when it was replaced (--force).
export interface DroppedOption {
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
  constructor(private exec: GraphQLExecutor) {}

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
    const data = await this.exec(Q_PROJECTS, { owner, repo });
    const nodes: any[] = data.repository?.projectsV2?.nodes ?? [];
    const match = nodes.find((n) => n.title === opts.title);
    return match ? { id: match.id, number: match.number, title: match.title } : null;
  }

  async readFields(projectId: string): Promise<ProjectState> {
    const data = await this.exec(Q_PROJECT_FIELDS, { project: projectId });
    return stateFromNode(data.node);
  }

  // Item count per Status option name, across every page.
  private async statusUsage(projectId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    let after: string | undefined;
    do {
      // The cursor is only sent when present: ghExecutor encodes every variable
      // it is given, and "$after: String" may simply be omitted on page one.
      const data = await this.exec(Q_STATUS_USAGE, after ? { project: projectId, after } : { project: projectId });
      const items = data.node?.items;
      for (const n of items?.nodes ?? []) {
        const name = n?.fieldValueByName?.name;
        if (name) counts[name] = (counts[name] ?? 0) + 1;
      }
      after = items?.pageInfo?.hasNextPage ? items.pageInfo.endCursor : undefined;
    } while (after);
    return counts;
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
    return diffState(state, opts.title);
  }

  // Creates or adopts the project, executes exactly the planned mutations, then
  // re-reads and builds the validated BoardConfig. Does not touch the filesystem
  // (see writeConfig) so it stays unit-testable.
  async apply(owner: string, repo: string, opts: ApplyOptions): Promise<ApplyResult> {
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
    const actions = diffState(state, opts.title).filter((a) => a.kind !== "create-project");

    // Destructive-adopt guard (issue #14 item 5). Replacing the Status options
    // deletes every non-canonical option, and items assigned to a deleted
    // option silently lose their Status. On an adopted board (never one we just
    // created: its default options hold zero items) refuse before ANY mutation
    // runs, unless --force; --force still surfaces what is dropped.
    let dropped: DroppedOption[] = [];
    if (!created && actions.some((a) => a.kind === "set-status-options")) {
      const status = state.fields.find((f) => f.name === STATUS_FIELD_NAME);
      const nonCanonical = (status?.options ?? [])
        .map((o) => o.name)
        .filter((n) => !(STATUS_OPTIONS as readonly string[]).includes(n));
      if (nonCanonical.length) {
        const usage = await this.statusUsage(header.id);
        dropped = nonCanonical
          .map((name) => ({ name, count: usage[name] ?? 0 }))
          .filter((d) => d.count > 0);
        if (dropped.length && !opts.force) {
          const detail = dropped.map((d) => `  "${d.name}": ${d.count} item(s)`).join("\n");
          throw new ZError(
            `Refusing to adopt project #${header.number} "${header.title}": replacing the Status ` +
              `options would delete non-canonical options that still have items assigned ` +
              `(those items silently lose their Status):\n${detail}\n` +
              `Re-run with --force to drop them anyway.`
          );
        }
      }
    }

    for (const a of actions) {
      if (a.kind === "set-status-options") {
        const fieldId = requireFieldId(state, STATUS_FIELD_NAME);
        await this.exec(mUpdateFieldOptions(a.options), { field: fieldId });
      } else if (a.kind === "create-field") {
        if (a.dataType === "SINGLE_SELECT") {
          await this.exec(mCreateSingleSelectField(a.options!), { project: header.id, name: a.name });
        } else {
          await this.exec(M_CREATE_NUMBER_FIELD, { project: header.id, name: a.name });
        }
      } else if (a.kind === "set-field-options") {
        const fieldId = requireFieldId(state, a.name);
        await this.exec(mUpdateFieldOptions(a.options), { field: fieldId });
      }
    }

    // Re-read only if we changed something; a no-op run reuses the state it read.
    const finalState = actions.length ? await this.readFields(header.id) : state;
    const config = buildConfig(finalState, { owner, repo, repositoryId, ...opts });
    validateConfig(config);
    return { config, actions, created, dropped };
  }

  async verify(owner: string, repo: string, opts: { number?: number; title: string }): Promise<VerifyReport> {
    const state = await this.readState(owner, repo, opts);
    return verifyReport(state);
  }
}

function stateFromNode(node: any): ProjectState {
  if (!node || node.id === undefined) throw new ZError("Project not found (node returned null).");
  const fields: FieldState[] = (node.fields?.nodes ?? [])
    .filter((f: any) => f && f.name && f.dataType)
    .map((f: any) => ({
      id: f.id,
      name: f.name,
      dataType: f.dataType as FieldDataType,
      options: f.options ? f.options.map((o: any) => ({ id: o.id, name: o.name })) : undefined,
    }));
  return { id: node.id, number: node.number, title: node.title, fields };
}

function requireFieldId(state: ProjectState, name: string): string {
  const f = state.fields.find((x) => x.name === name);
  if (!f) throw new ZError(`Field "${name}" not found on project "${state.title}" after setup.`);
  return f.id;
}

function buildConfig(
  state: ProjectState,
  ctx: { owner: string; repo: string; repositoryId: string } & ApplyOptions
): BoardConfig {
  const status = state.fields.find((f) => f.name === STATUS_FIELD_NAME);
  if (!status) throw new ZError(`Status field missing on "${state.title}" after setup.`);

  const fields: Record<string, FieldConfig> = {};
  for (const df of CUSTOM_FIELDS) {
    const f = state.fields.find((sf) => sf.name === df.name);
    if (!f) throw new ZError(`Field "${df.name}" missing on "${state.title}" after setup.`);
    fields[df.name] =
      df.dataType === "SINGLE_SELECT"
        ? { id: f.id, dataType: "SINGLE_SELECT", options: optionMap(f.options) }
        : { id: f.id, dataType: df.dataType };
  }

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

  plan   --owner O --repo R --title T [--project-number N]
         print the mutations needed to reach the canonical board (zero writes)
  apply  --owner O --repo R --slug S --title T [--project-number N] [--force]
         [--epic-style milestones] [--max-lanes 3] [--watchdog-minutes 10]
         create/adopt the project, run the mutations, write config.json
         (adopting a board whose non-canonical Status options still hold items
         refuses and lists them unless --force is given)
  verify --owner O --repo R [--title T | --project-number N]
         check the live board against the 9 statuses + 4 fields; non-zero on drift

Statuses: ${STATUS_OPTIONS.join(", ")}
Fields:   ${CUSTOM_FIELDS.map((f) => f.name).join(", ")}`;

interface Parsed {
  flags: Record<string, string>;
}

// Flags that take no value; everything else consumes the next argument.
const BOOLEAN_FLAGS = new Set(["force"]);

function parseFlags(args: string[]): Parsed {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const name = args[i].slice(2);
    flags[name] = BOOLEAN_FLAGS.has(name) ? "true" : args[++i];
  }
  return { flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new ZError(`Missing required --${name}.`);
  return v;
}

// Exported for the gate test: rejecting "issue-type" here keeps the CLI from
// ever calling GraphQL with a config the loop cannot act on (issue #14 item 6).
export function toEpicStyle(v: string | undefined): EpicStyle | undefined {
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
    const { flags } = parseFlags(argv.slice(1));
    const owner = requireFlag(flags, "owner");
    const repo = requireFlag(flags, "repo");
    const number = flags["project-number"] ? Number(flags["project-number"]) : undefined;
    if (number !== undefined && !Number.isInteger(number)) {
      throw new ZError(`--project-number must be an integer, got "${flags["project-number"]}".`);
    }
    const setup = new SetupBoard(ghExecutor());

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
        return 0;
      }
      case "apply": {
        const slug = requireFlag(flags, "slug");
        const title = requireFlag(flags, "title");
        const result = await setup.apply(owner, repo, {
          slug,
          title,
          projectNumber: number,
          epicStyle: toEpicStyle(flags["epic-style"]),
          maxLanes: flags["max-lanes"] ? Number(flags["max-lanes"]) : undefined,
          watchdogMinutes: flags["watchdog-minutes"] ? Number(flags["watchdog-minutes"]) : undefined,
          force: flags["force"] === "true",
        });
        const path = writeConfig(result.config);
        console.log(
          `${result.created ? "Created" : "Adopted"} project #${result.config.projectNumber} ` +
            `"${result.config.projectId}" with ${result.actions.length} mutation(s).`
        );
        if (result.dropped.length) {
          console.log(
            "--force dropped non-canonical Status options that had items: " +
              result.dropped.map((d) => `"${d.name}" (${d.count} item(s))`).join(", ")
          );
        }
        console.log(`Wrote ${path}`);
        return 0;
      }
      case "verify": {
        const title = flags["title"];
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
    if (e instanceof ZError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
