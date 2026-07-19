// The one and only board contract for the pack (epic #3, decision D4): every
// GitHub Projects access funnels through Board so a future swagger/MCP backend
// is a new executor, not a rewrite -- and so the issue #2 GraphQL quota guard
// sits on the single choke point no caller can route around.
//
// GitHub Projects v2 is the v1 backend. The gh/GraphQL call is injected
// (GraphQLExecutor) so gate tests run against recorded fixtures with zero
// network; production wires ghExecutor().
import { readFileSync } from "node:fs";
import {
  BoardConfig,
  DEFAULT_QUOTA,
  FieldConfig,
  loadConfig,
  ZError,
} from "./config.ts";

export { ZError } from "./config.ts";

// data payload of a GraphQL response (the value under the top-level "data" key).
export type GraphQLData = Record<string, any>;
export type GraphQLExecutor = (
  query: string,
  variables: Record<string, unknown>
) => Promise<GraphQLData>;
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- GraphQL operations. Each is named so the fixture router can key off it;
// every value shape is scalar-only so the real gh executor never has to encode
// list/object variables (see ghExecutor). --------------------------------------
const Q_RATE_LIMIT = `query RateLimit { rateLimit { remaining resetAt } }`;

const Q_PROJECT_ITEMS = `query ProjectItems($project: ID!) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          content { ... on Issue { number title url } }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
            }
          }
        }
      }
    }
  }
}`;

const Q_ISSUE_LOOKUP = `query IssueLookup($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id number title body
      assignees(first: 10) { nodes { login } }
      projectItems(first: 20) { nodes { id project { number } } }
    }
  }
}`;

const Q_FIELD_VALUE = `query FieldValue($owner: String!, $repo: String!, $number: Int!, $field: String!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 20) {
        nodes {
          project { number }
          fieldValueByName(name: $field) {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name }
            ... on ProjectV2ItemFieldTextValue { text }
            ... on ProjectV2ItemFieldNumberValue { number }
          }
        }
      }
    }
  }
}`;

const Q_ISSUE_ASSIGNEES = `query IssueAssignees($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { assignees(first: 10) { nodes { login } } }
  }
}`;

const Q_USER_ID = `query UserId($login: String!) { user(login: $login) { id } }`;

const Q_REPO_META = `query RepoMeta($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    id
    milestones(first: 50) { nodes { id title } }
    labels(first: 100) { nodes { id name } }
  }
}`;

const M_SET_SINGLE_SELECT = `mutation SetSingleSelect($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) { projectV2Item { id } }
}`;

const M_SET_NUMBER = `mutation SetNumber($project: ID!, $item: ID!, $field: ID!, $number: Float!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {number: $number}}) { projectV2Item { id } }
}`;

const M_SET_TEXT = `mutation SetText($project: ID!, $item: ID!, $field: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {text: $text}}) { projectV2Item { id } }
}`;

const M_ADD_COMMENT = `mutation AddComment($subject: ID!, $body: String!) {
  addComment(input: {subjectId: $subject, body: $body}) { clientMutationId }
}`;

const M_UPDATE_BODY = `mutation UpdateIssueBody($id: ID!, $body: String!) {
  updateIssue(input: {id: $id, body: $body}) { issue { number } }
}`;

const M_ADD_ASSIGNEES = `mutation AddAssignees($assignable: ID!, $user: ID!) {
  addAssigneesToAssignable(input: {assignableId: $assignable, assigneeIds: [$user]}) { clientMutationId }
}`;

const M_REMOVE_ASSIGNEES = `mutation RemoveAssignees($assignable: ID!, $user: ID!) {
  removeAssigneesFromAssignable(input: {assignableId: $assignable, assigneeIds: [$user]}) { clientMutationId }
}`;

const M_CREATE_ISSUE = `mutation CreateIssue($repo: ID!, $title: String!, $body: String!, $milestone: ID!) {
  createIssue(input: {repositoryId: $repo, title: $title, body: $body, milestoneId: $milestone}) { issue { id number url } }
}`;

const M_CREATE_ISSUE_LABELED = `mutation CreateIssueLabeled($repo: ID!, $title: String!, $body: String!, $milestone: ID!, $label: ID!) {
  createIssue(input: {repositoryId: $repo, title: $title, body: $body, milestoneId: $milestone, labelIds: [$label]}) { issue { id number url } }
}`;

// Adds a just-created issue to the project board. Scalar variables only, so the
// ghExecutor encodes it the same way as every other mutation here.
const M_ADD_PROJECT_ITEM = `mutation AddProjectItem($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } }
}`;

export interface BoardItem {
  number: number;
  title: string;
  url: string;
  fields: Record<string, string | number>;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export interface QuotaStatus {
  remaining: number;
  resetAt: string;
}

export class Board {
  private threshold: number;
  private mode: "sleep" | "abort";

  constructor(
    private cfg: BoardConfig,
    private exec: GraphQLExecutor,
    private sleep: Sleep = defaultSleep,
    // Injected so the quota-guard test is deterministic (no wall clock).
    private now: () => number = () => Date.now()
  ) {
    this.threshold = cfg.quota?.threshold ?? DEFAULT_QUOTA.threshold;
    this.mode = cfg.quota?.mode ?? DEFAULT_QUOTA.mode;
  }

  // The only guarded path to the backend. Every subcommand calls gql(); the
  // quota probe is enforced here so no call path can bypass it (issue #2).
  private async gql(query: string, variables: Record<string, unknown> = {}) {
    await this.enforceQuota();
    return this.exec(query, variables);
  }

  // Probes remaining points and either waits for the window to reset or aborts.
  // Calls exec() directly (not gql) because the probe IS the guard -- gating it
  // on itself would recurse. GitHub's rateLimit query costs 0 points, so the
  // extra probe per call is free. ponytail: probes before every call rather
  // than piggybacking rateLimit onto each query; upgrade path is inlining it.
  private async enforceQuota(): Promise<void> {
    const data = await this.exec(Q_RATE_LIMIT, {});
    const rl = data.rateLimit;
    if (!rl || rl.remaining >= this.threshold) return;
    if (this.mode === "abort") {
      throw new ZError(
        `GraphQL quota exhausted: ${rl.remaining} < ${this.threshold} remaining. Resets at ${rl.resetAt}.`
      );
    }
    const ms = Math.max(0, new Date(rl.resetAt).getTime() - this.now());
    await this.sleep(ms);
  }

  async quota(): Promise<QuotaStatus> {
    // Reporting quota must never be gated on quota, so probe directly.
    const data = await this.exec(Q_RATE_LIMIT, {});
    return data.rateLimit as QuotaStatus;
  }

  async list(status: string): Promise<BoardItem[]> {
    this.assertStatus(status);
    const data = await this.gql(Q_PROJECT_ITEMS, { project: this.cfg.projectId });
    const nodes: any[] = data.node?.items?.nodes ?? [];
    return nodes
      .map((n) => toItem(n))
      .filter((it): it is BoardItem => it !== null && it.fields["Status"] === status);
  }

  async move(n: number, status: string): Promise<void> {
    this.assertStatus(status);
    const option = this.cfg.statusField.options![status];
    const item = await this.itemId(n);
    await this.gql(M_SET_SINGLE_SELECT, {
      project: this.cfg.projectId,
      item,
      field: this.cfg.statusField.id,
      option,
    });
  }

  async comment(n: number, bodyFile: string): Promise<void> {
    const body = readBody(bodyFile);
    const issue = await this.lookup(n);
    await this.gql(M_ADD_COMMENT, { subject: issue.id, body });
  }

  async fieldGet(n: number, field: string): Promise<string | number | null> {
    this.assertField(field);
    const data = await this.gql(Q_FIELD_VALUE, {
      owner: this.cfg.owner,
      repo: this.cfg.repo,
      number: n,
      field,
    });
    const items: any[] = data.repository?.issue?.projectItems?.nodes ?? [];
    const item =
      items.find((i) => i.project?.number === this.cfg.projectNumber) ?? items[0];
    return fieldValue(item?.fieldValueByName);
  }

  async fieldSet(n: number, field: string, value: string): Promise<void> {
    this.assertField(field);
    const fc = this.cfg.fields[field];
    const item = await this.itemId(n);
    const base = { project: this.cfg.projectId, item, field: fc.id };

    if (fc.dataType === "SINGLE_SELECT") {
      const option = fc.options?.[value];
      if (!option) {
        throw new ZError(
          `Unknown value "${value}" for ${field}. Valid: ${Object.keys(fc.options ?? {}).join(", ")}`
        );
      }
      await this.gql(M_SET_SINGLE_SELECT, { ...base, option });
    } else if (fc.dataType === "NUMBER") {
      const num = Number(value);
      if (Number.isNaN(num)) throw new ZError(`${field} expects a number, got "${value}".`);
      await this.gql(M_SET_NUMBER, { ...base, number: num });
    } else {
      await this.gql(M_SET_TEXT, { ...base, text: value });
    }
  }

  async create(
    title: string,
    bodyFile: string,
    milestone: string,
    label?: string
  ): Promise<CreatedIssue> {
    const body = readBody(bodyFile);
    const meta = await this.gql(Q_REPO_META, {
      owner: this.cfg.owner,
      repo: this.cfg.repo,
    });
    const repository = meta.repository;
    const ms = (repository?.milestones?.nodes ?? []).find(
      (m: any) => m.title === milestone
    );
    if (!ms) {
      const valid = (repository?.milestones?.nodes ?? []).map((m: any) => m.title);
      throw new ZError(`Milestone "${milestone}" not found. Valid: ${valid.join(", ")}`);
    }

    const vars: Record<string, unknown> = {
      repo: repository.id,
      title,
      body,
      milestone: ms.id,
    };
    let query = M_CREATE_ISSUE;
    if (label) {
      const lbl = (repository?.labels?.nodes ?? []).find((l: any) => l.name === label);
      if (!lbl) {
        const valid = (repository?.labels?.nodes ?? []).map((l: any) => l.name);
        throw new ZError(`Label "${label}" not found. Valid: ${valid.join(", ")}`);
      }
      vars.label = lbl.id;
      query = M_CREATE_ISSUE_LABELED;
    }

    const data = await this.gql(query, vars);
    const issue = data.createIssue.issue as CreatedIssue & { id: string };
    // Fold-in gap from C2 (issue #5): a created issue must land ON the board, or
    // it never shows up in `list`/`move` and the loop can't see it. addProjectV2-
    // ItemById is idempotent server-side, so re-adding an existing item is safe.
    await this.gql(M_ADD_PROJECT_ITEM, { project: this.cfg.projectId, content: issue.id });
    return { number: issue.number, url: issue.url };
  }

  // Records a dependency both ways: N "Depends on #M", M "Blocks #N". Each side
  // gets a body line (idempotent) plus a comment. If the body line already
  // exists the side is skipped so re-running never double-comments.
  async link(n: number, m: number): Promise<void> {
    const [a, b] = await Promise.all([this.lookup(n), this.lookup(m)]);
    await this.addRelation(a, `Depends on #${m}`);
    await this.addRelation(b, `Blocks #${n}`);
  }

  private async addRelation(issue: IssueNode, line: string): Promise<void> {
    if ((issue.body ?? "").includes(line)) return;
    const body = issue.body && issue.body.length ? `${issue.body}\n\n${line}` : line;
    await this.gql(M_UPDATE_BODY, { id: issue.id, body });
    await this.gql(M_ADD_COMMENT, { subject: issue.id, body: line });
  }

  // Atomic claim. Assignee sets are not compare-and-swap, so: refuse if already
  // assigned; otherwise add self and re-read -- GitHub returns assignees in
  // assignment order, so the first entry is the winner. A concurrent loser sees
  // someone else at index 0, backs its own assignment out, and fails non-zero.
  // Net effect: exactly one claimer survives any interleaving.
  // ponytail: relies on GitHub's assignee ordering as the tiebreaker; upgrade
  // path is a dedicated lock field if that ordering ever proves unstable.
  async claim(n: number, assignee: string): Promise<void> {
    const issue = await this.lookup(n);
    const existing = issue.assignees.nodes.map((a) => a.login);
    if (existing.length > 0) {
      if (existing.length === 1 && existing[0] === assignee) return; // already ours
      throw new ZError(`Issue #${n} already claimed by ${existing.join(", ")}.`);
    }

    const user = await this.userId(assignee);
    await this.gql(M_ADD_ASSIGNEES, { assignable: issue.id, user });

    const after = await this.assignees(n);
    if (after[0] === assignee) return;

    await this.gql(M_REMOVE_ASSIGNEES, { assignable: issue.id, user });
    throw new ZError(`Issue #${n} was claimed concurrently by ${after[0] ?? "another agent"}.`);
  }

  // -- helpers ---------------------------------------------------------------
  private assertStatus(status: string): void {
    const valid = Object.keys(this.cfg.statusField.options ?? {});
    if (!valid.includes(status)) {
      throw new ZError(`Unknown status "${status}". Valid: ${valid.join(", ")}`);
    }
  }

  private assertField(field: string): void {
    const valid = Object.keys(this.cfg.fields);
    if (!valid.includes(field)) {
      throw new ZError(`Unknown field "${field}". Valid: ${valid.join(", ")}`);
    }
  }

  private async lookup(n: number): Promise<IssueNode> {
    const data = await this.gql(Q_ISSUE_LOOKUP, {
      owner: this.cfg.owner,
      repo: this.cfg.repo,
      number: n,
    });
    const issue = data.repository?.issue;
    if (!issue) throw new ZError(`Issue #${n} not found in ${this.cfg.owner}/${this.cfg.repo}.`);
    return issue as IssueNode;
  }

  private async itemId(n: number): Promise<string> {
    const issue = await this.lookup(n);
    const item = issue.projectItems.nodes.find(
      (i) => i.project?.number === this.cfg.projectNumber
    );
    if (!item) {
      throw new ZError(
        `Issue #${n} is not on project ${this.cfg.slug} (#${this.cfg.projectNumber}).`
      );
    }
    return item.id;
  }

  private async assignees(n: number): Promise<string[]> {
    const data = await this.gql(Q_ISSUE_ASSIGNEES, {
      owner: this.cfg.owner,
      repo: this.cfg.repo,
      number: n,
    });
    return (data.repository?.issue?.assignees?.nodes ?? []).map((a: any) => a.login);
  }

  private async userId(login: string): Promise<string> {
    const data = await this.gql(Q_USER_ID, { login });
    const id = data.user?.id;
    if (!id) throw new ZError(`GitHub user "${login}" not found.`);
    return id;
  }
}

interface IssueNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  assignees: { nodes: { login: string }[] };
  projectItems: { nodes: { id: string; project: { number: number } | null }[] };
}

function toItem(node: any): BoardItem | null {
  const content = node?.content;
  if (!content || content.number === undefined) return null;
  const fields: Record<string, string | number> = {};
  for (const fv of node.fieldValues?.nodes ?? []) {
    const name = fv?.field?.name;
    if (!name) continue;
    const v = fieldValue(fv);
    if (v !== null) fields[name] = v;
  }
  return { number: content.number, title: content.title, url: content.url, fields };
}

// Reads a scalar out of a ProjectV2ItemFieldValue union member.
function fieldValue(fv: any): string | number | null {
  if (!fv) return null;
  switch (fv.__typename) {
    case "ProjectV2ItemFieldSingleSelectValue":
      return fv.name ?? null;
    case "ProjectV2ItemFieldTextValue":
      return fv.text ?? null;
    case "ProjectV2ItemFieldNumberValue":
      return fv.number ?? null;
    default:
      // No __typename in a targeted fieldValueByName fixture: fall back to the
      // first scalar present.
      return fv.name ?? fv.text ?? fv.number ?? null;
  }
}

function readBody(bodyFile: string): string {
  try {
    return readFileSync(bodyFile, "utf8");
  } catch {
    throw new ZError(`Cannot read --body-file "${bodyFile}".`);
  }
}

// Production executor: shells out to `gh api graphql`. This is the ONLY place in
// the whole pack allowed to call gh directly (enforced by a grep gate test).
// All operation variables are scalars, so -f (string) / -F (typed) suffice and
// we never have to encode list/object variables on the CLI.
export function ghExecutor(): GraphQLExecutor {
  return async (query, variables) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
      if (typeof v === "number" || typeof v === "boolean") args.push("-F", `${k}=${v}`);
      else args.push("-f", `${k}=${v}`);
    }
    const proc = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new ZError(`gh api graphql failed: ${proc.stderr.toString().trim()}`);
    }
    const out = JSON.parse(proc.stdout.toString());
    if (out.errors) throw new ZError(`GraphQL errors: ${JSON.stringify(out.errors)}`);
    return out.data;
  };
}

// -- CLI -------------------------------------------------------------------
const USAGE = `z-board <command> [args]

  list --status <S> [--json]        items in a status, with fields
  move <N> <S>                      set an issue's Status
  comment <N> --body-file <F>       add a comment
  field-get <N> <Field>             read a custom field (${FIELD_HINT()})
  field-set <N> <Field> <V>         write a custom field
  create --title T --body-file F --milestone M [--label L]
  link <N> <M>                      record N depends on M (both directions)
  claim <N> <assignee>             atomic assignee claim
  quota                            remaining GraphQL points

  --slug <name>                     which ~/.zstack/projects/<slug> to use`;

function FIELD_HINT(): string {
  return "Model | Model Effort | Estimate | Actual";
}

const COMMANDS = new Set([
  "list",
  "move",
  "comment",
  "field-get",
  "field-set",
  "create",
  "link",
  "claim",
  "quota",
]);

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseFlags(args: string[], booleans: string[] = []): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (booleans.includes(key)) flags[key] = true;
      else flags[key] = args[++i];
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function requireInt(v: string | undefined, label: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n)) {
    throw new ZError(`${label} must be an integer issue number, got "${v}".`);
  }
  return n;
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v) throw new ZError(`Missing required --${name}.`);
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  // Reject a bad command before touching config, so a typo doesn't masquerade
  // as a missing-config error.
  if (!COMMANDS.has(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }

  try {
    const { positionals, flags } = parseFlags(argv.slice(1), ["json"]);
    const slug = typeof flags.slug === "string" ? flags.slug : undefined;
    const cfg = loadConfig(slug);
    const board = new Board(cfg, ghExecutor());

    switch (cmd) {
      case "list": {
        const status = requireFlag(flags, "status");
        const items = await board.list(status);
        if (flags.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          for (const it of items) {
            const extra = Object.entries(it.fields)
              .filter(([k]) => k !== "Status")
              .map(([k, v]) => `${k}=${v}`)
              .join(" ");
            console.log(`#${it.number}  ${it.title}${extra ? "  [" + extra + "]" : ""}`);
          }
        }
        return 0;
      }
      case "move": {
        const n = requireInt(positionals[0], "issue");
        const status = positionals[1];
        if (!status) throw new ZError("Usage: z-board move <N> <S>");
        await board.move(n, status);
        console.log(`#${n} -> ${status}`);
        return 0;
      }
      case "comment": {
        const n = requireInt(positionals[0], "issue");
        await board.comment(n, requireFlag(flags, "body-file"));
        console.log(`commented on #${n}`);
        return 0;
      }
      case "field-get": {
        const n = requireInt(positionals[0], "issue");
        const field = positionals[1];
        if (!field) throw new ZError("Usage: z-board field-get <N> <Field>");
        const v = await board.fieldGet(n, field);
        console.log(v === null ? "" : String(v));
        return 0;
      }
      case "field-set": {
        const n = requireInt(positionals[0], "issue");
        const field = positionals[1];
        const value = positionals[2];
        if (!field || value === undefined) throw new ZError("Usage: z-board field-set <N> <Field> <V>");
        await board.fieldSet(n, field, value);
        console.log(`#${n} ${field} = ${value}`);
        return 0;
      }
      case "create": {
        const issue = await board.create(
          requireFlag(flags, "title"),
          requireFlag(flags, "body-file"),
          requireFlag(flags, "milestone"),
          typeof flags.label === "string" ? flags.label : undefined
        );
        console.log(`#${issue.number} ${issue.url}`);
        return 0;
      }
      case "link": {
        const n = requireInt(positionals[0], "issue");
        const m = requireInt(positionals[1], "dependency");
        await board.link(n, m);
        console.log(`#${n} depends on #${m}`);
        return 0;
      }
      case "claim": {
        const n = requireInt(positionals[0], "issue");
        const assignee = positionals[1];
        if (!assignee) throw new ZError("Usage: z-board claim <N> <assignee>");
        await board.claim(n, assignee);
        console.log(`claimed #${n} for ${assignee}`);
        return 0;
      }
      case "quota": {
        const q = await board.quota();
        console.log(`remaining=${q.remaining} resetAt=${q.resetAt}`);
        return 0;
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
