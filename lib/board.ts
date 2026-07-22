// The one and only board contract for the pack (epic #3, decision D4): every
// GitHub Projects access funnels through Board so a future swagger/MCP backend
// is a new executor, not a rewrite -- and so the issue #2 GraphQL quota guard
// sits on the single choke point no caller can route around.
//
// GitHub Projects v2 is the v1 backend. The gh/GraphQL call is injected
// (GraphQLExecutor) so gate tests run against recorded fixtures with zero
// network; production wires ghExecutor().
import { readFileSync } from "node:fs";
import { atomicWrite, handleCliError, parseFlags, requireFlag, str } from "./cli.ts";
import {
  BoardConfig,
  DEFAULT_QUOTA,
  FieldConfig,
  loadConfig,
  ZError,
} from "./config.ts";

// data payload of a GraphQL response (the value under the top-level "data" key).
export type GraphQLData = Record<string, any>;
export type GraphQLExecutor = (
  query: string,
  variables: Record<string, unknown>
) => Promise<GraphQLData>;
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// #127: a transient GitHub read can return 0 items for a board that really has
// many (observed live: one snapshot() returned 0, the very next returned all
// 68). snapshot() retries a small, bounded number of times on an EMPTY read
// before trusting it. ponytail: fixed 3x/500ms backoff, not adaptive -- the one
// board where this is slow (genuinely empty, i.e. before any ticket exists) is a
// state a mid-drain loop is never in; upgrade path is exponential backoff if the
// hiccup window ever proves longer than ~1.5s.
const SNAPSHOT_EMPTY_RETRIES = 3;
const SNAPSHOT_RETRY_MS = 500;

// One cursor-pagination loop for every connection the pack walks: Board's
// ProjectItems (below) and SetupBoard's Projects / ProjectFields / FieldUsage
// (lib/setup-board.ts). Truncation is never cosmetic on any of them -- a
// dropped ProjectItems page silently loses tickets, an undercounted FieldUsage
// waves a destructive adopt through, a missed Projects page creates a
// duplicate -- so every malformed shape throws, naming `what`, instead of
// being read as "that was the last page":
//
//   * nodes but no pageInfo  -- a malformed response, NOT a drained connection.
//   * hasNextPage, no cursor -- an advertised page that cannot be followed.
//   * the same cursor twice  -- would refetch one page forever.
//
// The page callback receives undefined on page one so callers can omit the
// cursor variable entirely (ghExecutor encodes every variable it is given).
export interface Connection<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: (T | null)[];
}

export async function paginate<T>(
  what: string,
  page: (after: string | undefined) => Promise<Connection<T> | null | undefined>
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const conn = await page(after);
    const nodes = conn?.nodes ?? [];
    for (const n of nodes) if (n != null) out.push(n);
    const info = conn?.pageInfo;
    if (!info) {
      if (nodes.length > 0) {
        throw new ZError(
          `${what} returned ${nodes.length} node(s) but no pageInfo -- malformed response, refusing to treat the connection as fully listed.`
        );
      }
      return out;
    }
    if (!info.hasNextPage) return out;
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

// -- GraphQL operations. Each is named so the fixture router can key off it.
// Every value shape is scalar-only; the JSON-body executor (see ghExecutor)
// preserves each variable's type, so no CLI-level type coercion is involved. ---
const Q_RATE_LIMIT = `query RateLimit { rateLimit { remaining resetAt } }`;

// items is cursor-paginated in list() -- z-setup forces auto-archive OFF and the
// loop leaves Done issues OPEN, so growth past one page of 100 is guaranteed.
// fieldValues stays single-page with a loud overflow guard (assertSinglePage):
// its ceiling is 20 values per item against the board's 5 defined fields, and
// paginating a nested connection would need a per-item follow-up query.
const Q_PROJECT_ITEMS = `query ProjectItems($project: ID!, $cursor: String) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content { ... on Issue { number title url body } }
          fieldValues(first: 20) {
            pageInfo { hasNextPage }
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

// projectItems ceiling: 20 boards per issue; ours must be among them or itemId
// silently reports "not on project", so overflow throws via assertSinglePage.
const Q_ISSUE_LOOKUP = `query IssueLookup($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id number title body
      assignees(first: 10) { nodes { login } }
      projectItems(first: 20) { pageInfo { hasNextPage } nodes { id project { number } } }
    }
  }
}`;

const Q_FIELD_VALUE = `query FieldValue($owner: String!, $repo: String!, $number: Int!, $field: String!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 20) {
        pageInfo { hasNextPage }
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

const Q_USER_ID = `query UserId($login: String!) { user(login: $login) { id } }`;

// Ceilings: 50 milestones / 100 labels per repo. Overflow would turn a real
// milestone/label into a bogus "not found", so create() guards both with
// assertSinglePage rather than paginating a lookup this rarely-large.
const Q_REPO_META = `query RepoMeta($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    id
    milestones(first: 50) { pageInfo { hasNextPage } nodes { id title } }
    labels(first: 100) { pageInfo { hasNextPage } nodes { id name } }
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
    // Format-drift guard (same discipline as lib/cost.ts): a missing/renamed
    // rateLimit must fail LOUDLY, never silently disable the guard. Failing open
    // here means the loop hammers the API straight into a hard 403 with no pause.
    if (
      !rl ||
      typeof rl !== "object" ||
      typeof rl.remaining !== "number" ||
      typeof rl.resetAt !== "string"
    ) {
      throw new ZError(
        `GraphQL rateLimit probe returned no usable {remaining, resetAt} (got ${JSON.stringify(rl)}). ` +
          `GitHub's rateLimit response may have changed -- refusing to run unguarded against the API quota.`
      );
    }
    if (rl.remaining >= this.threshold) return;
    if (this.mode === "abort") {
      throw new ZError(
        `GraphQL quota exhausted: ${rl.remaining} < ${this.threshold} remaining. Resets at ${rl.resetAt}.`
      );
    }
    // A malformed resetAt yields NaN; Math.max(0, NaN) is NaN, and setTimeout(NaN)
    // fires immediately -- a busy-loop hammering the API instead of pausing. Refuse
    // loudly rather than sleep(NaN).
    const resetMs = new Date(rl.resetAt).getTime();
    if (!Number.isFinite(resetMs)) {
      throw new ZError(
        `GraphQL rateLimit.resetAt is not a parseable timestamp: ${JSON.stringify(rl.resetAt)}. ` +
          `Refusing to sleep(NaN), which would busy-hammer the API instead of pausing for the window.`
      );
    }
    const ms = Math.max(0, resetMs - this.now());
    await this.sleep(ms);
  }

  async quota(): Promise<QuotaStatus> {
    // Reporting quota must never be gated on quota, so probe directly.
    const data = await this.exec(Q_RATE_LIMIT, {});
    return data.rateLimit as QuotaStatus;
  }

  // The cursor-paginated ProjectItems node list behind BOTH list() and
  // snapshot(), with the F3 malformed-response guards. Returns the raw item
  // nodes so each caller reads the fields it needs: list() -> BoardItem via
  // toItem; snapshot() -> BoardItem + the issue body that rides on the same
  // query (content.body). Single source of the pagination + guards so the two
  // callers can never drift.
  private async listNodes(): Promise<any[]> {
    // Cursor pagination (issue #14 item 1): the board WILL exceed 100 items
    // (auto-archive is forced off and Done issues stay open), so truncation
    // here silently drops tickets. paginate() above owns the F3a/F3b/F3c
    // malformed-response guards, shared with setup-board's connections.
    return paginate<any>("ProjectItems", async (cursor) => {
      const vars: Record<string, unknown> = { project: this.cfg.projectId };
      if (cursor !== undefined) vars.cursor = cursor;
      return (await this.gql(Q_PROJECT_ITEMS, vars)).node?.items;
    });
  }

  // status omitted = every item on the board (F0): the one-call atomic
  // snapshot contract z-status consumes via `z-board list --json`.
  async list(status?: string): Promise<BoardItem[]> {
    if (status !== undefined) this.assertStatus(status);
    const nodes = await this.listNodes();
    return nodes
      .map((n) => toItem(n))
      .filter(
        (it): it is BoardItem =>
          it !== null && (status === undefined || it.fields["Status"] === status)
      );
  }

  // One-call board snapshot for the /z-loop drain (ticket #57, Leak 2): every
  // item across all nine statuses PLUS each ticket's issue body, from a SINGLE
  // paginated ProjectItems pass (body rides on content.body, so this is one
  // query, not an N+1 per-issue lookup). This keeps lib/board.ts the sole `gh`
  // caller: bin/z-loop-tick reads bodies through here instead of shelling
  // `gh issue view`, so the caller gate (tests/board.test.ts) stays satisfied.
  // The bodies map is keyed by issue number (as a string), the exact shape
  // loop.ts `ingest` consumes for dependency parsing.
  async snapshot(): Promise<{ items: BoardItem[]; bodies: Record<string, string> }> {
    // #127: an empty read here is almost always a transient hiccup, not a truly
    // empty board -- and the drain loop trusts this snapshot to decide
    // drain-complete, so believing a bogus empty read falsely ends the batch and
    // orphans in-flight lanes. Retry a bounded number of times before trusting a
    // 0-item read; a genuinely empty board still returns [] once retries exhaust.
    let nodes = await this.listNodes();
    for (let attempt = 0; nodes.length === 0 && attempt < SNAPSHOT_EMPTY_RETRIES; attempt++) {
      await this.sleep(SNAPSHOT_RETRY_MS);
      nodes = await this.listNodes();
    }
    const items: BoardItem[] = [];
    const bodies: Record<string, string> = {};
    for (const n of nodes) {
      const it = toItem(n);
      if (!it) continue;
      items.push(it);
      // A null/absent body (rare, but GitHub can return null) serializes as ""
      // so ingest's parseDependsOn never sees undefined.
      bodies[String(it.number)] = n.content?.body ?? "";
    }
    return { items, bodies };
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
    const issue = data.repository?.issue;
    if (!issue) throw new ZError(`Issue #${n} not found in ${this.cfg.owner}/${this.cfg.repo}.`);
    assertSinglePage(issue.projectItems, `projectItems for issue #${n} (ceiling: 20 boards per issue)`);
    const items: any[] = issue.projectItems?.nodes ?? [];
    // No cross-project fallback: another board's same-named field is not our value.
    const item = items.find((i) => i.project?.number === this.cfg.projectNumber);
    if (!item) {
      throw new ZError(
        `Issue #${n} is not on project ${this.cfg.slug} (#${this.cfg.projectNumber}).`
      );
    }
    return fieldValue(item.fieldValueByName);
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
      // F4: Number("") and Number("  ") are 0, so a failed upstream pipeline
      // emitting a blank would silently zero a board field (e.g. Actual). Only
      // a non-blank string parsing to a FINITE number may reach the mutation.
      const num = value.trim() === "" ? NaN : Number(value);
      if (!Number.isFinite(num)) throw new ZError(`${field} expects a number, got "${value}".`);
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
    // Overflow past the RepoMeta page sizes would misreport a real milestone or
    // label as "not found" -- fail loudly instead (ceilings named on Q_REPO_META).
    assertSinglePage(repository?.milestones, `milestones for ${this.cfg.owner}/${this.cfg.repo} (ceiling: 50)`);
    assertSinglePage(repository?.labels, `labels for ${this.cfg.owner}/${this.cfg.repo} (ceiling: 100)`);
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

  // In-process serialization for addRelation (F2): one promise chain per
  // issue, so concurrent link() calls in this process never interleave their
  // read-modify-write phases at all. Static because two Board instances in one
  // process still share the same GitHub issue. Entries self-remove once the
  // chain drains. KNOWN CEILING: a writer in ANOTHER process can still clobber
  // us after our verification passes -- GitHub's updateIssue has no
  // compare-and-swap, so the verify-retry loop plus the loud bounded failure
  // below is the best available cross-process defense.
  private static relationLocks = new Map<string, Promise<void>>();

  private async withRelationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = Board.relationLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run even when the predecessor failed
    const tail = run.then(
      () => undefined,
      () => undefined // a rejection must not poison the chain for the next waiter
    );
    Board.relationLocks.set(key, tail);
    void tail.then(() => {
      if (Board.relationLocks.get(key) === tail) Board.relationLocks.delete(key);
    });
    return run;
  }

  // Body appends are read-modify-write with no server-side CAS, so a concurrent
  // link() that read the same base body can clobber our line (issue #14 item
  // 10). Mirror setup-permissions.verifyWrite: after writing, re-read and
  // confirm the line survived; on a lost update, re-append against the fresh
  // body and retry (bounded), then fail loudly instead of reporting success on
  // a write that didn't stick. Presence checks are line-exact (hasLine, F1):
  // substring includes() let "Depends on #12" satisfy a check for
  // "Depends on #1", so a clobbered write false-verified and the pre-check
  // silently no-opped a needed append.
  private async addRelation(issue: IssueNode, line: string): Promise<void> {
    if (hasLine(issue.body, line)) return; // pre-existing: skip body write AND comment
    const key = `${this.cfg.owner}/${this.cfg.repo}#${issue.number}`;
    await this.withRelationLock(key, async () => {
      // Re-read inside the lock: the caller's snapshot may predate the append
      // of a writer we queued behind -- writing from it would drop that line.
      let current = await this.lookup(issue.number);
      if (hasLine(current.body, line)) return; // appended while we queued
      const RETRIES = 3;
      for (let attempt = 1; ; attempt++) {
        const body = current.body && current.body.length ? `${current.body}\n\n${line}` : line;
        await this.gql(M_UPDATE_BODY, { id: current.id, body });
        current = await this.lookup(current.number);
        if (hasLine(current.body, line)) break;
        if (attempt >= RETRIES) {
          throw new ZError(
            `Issue #${current.number}: relation line "${line}" did not survive ${RETRIES} body writes -- ` +
              `a concurrent writer keeps clobbering it. Re-run z-board link once the other writer settles.`
          );
        }
      }
      await this.gql(M_ADD_COMMENT, { subject: issue.id, body: line });
    });
  }

  // Atomic claim. Assignee sets are not compare-and-swap, so: refuse if already
  // assigned; otherwise add self and re-read -- GitHub returns assignees in
  // assignment order, so the first entry is the winner. A concurrent loser sees
  // someone else at index 0, backs its own assignment out, and fails non-zero.
  // Net effect: exactly one claimer survives any interleaving.
  // ponytail: relies on GitHub's assignee ordering as the tiebreaker; upgrade
  // path is a dedicated lock field if that ordering ever proves unstable.
  //
  // KNOWN LIMITATION (issue #14 C8): claims are keyed on the GitHub LOGIN, not the
  // per-run session. GitHub assignees ARE logins, so a session id cannot be stored
  // as one. The cross-run guard against a SECOND loop is the per-machine loop lock
  // in ~/.zstack (lib/locks.ts) -- which is exactly that, PER MACHINE. Running two
  // loops under the SAME login on DIFFERENT machines is therefore UNSUPPORTED: both
  // see "sole assignee is me" below, treat the ticket as already-ours, and both
  // proceed -- duplicate lanes, branches, racing merges. A safe fix needs shared
  // cross-machine state (a claim marker the board holds and both loops check),
  // which is board-schema design beyond this remediation; see z-loop/SKILL.md.
  async claim(n: number, assignee: string): Promise<void> {
    const issue = await this.lookup(n);
    const existing = issue.assignees.nodes.map((a) => a.login);
    if (existing.length > 0) {
      if (existing.length === 1 && existing[0] === assignee) return; // already ours (per-login; see KNOWN LIMITATION above)
      throw new ZError(`Issue #${n} already claimed by ${existing.join(", ")}.`);
    }

    const user = await this.userId(assignee);
    await this.gql(M_ADD_ASSIGNEES, { assignable: issue.id, user });

    // Re-read to settle a concurrent claim: lookup() already returns the
    // assignee list, so this is the same round trip, not a second query shape.
    const after = (await this.lookup(n)).assignees.nodes.map((a) => a.login);
    if (after[0] === assignee) return;

    await this.gql(M_REMOVE_ASSIGNEES, { assignable: issue.id, user });
    throw new ZError(`Issue #${n} was claimed concurrently by ${after[0] ?? "another agent"}.`);
  }

  // Releases a claim: removes every current assignee so a future loop can
  // re-claim the ticket. Used by /z-loop --reconcile (C7, issue #2) when a
  // crashed lane left a ticket assigned to a dead session. A no-op when
  // unassigned. Returns the logins it removed.
  async release(n: number): Promise<string[]> {
    const issue = await this.lookup(n);
    const logins = issue.assignees.nodes.map((a) => a.login);
    for (const login of logins) {
      const user = await this.userId(login);
      await this.gql(M_REMOVE_ASSIGNEES, { assignable: issue.id, user });
    }
    return logins;
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
    // Our project must be on the first page or itemId misreports "not on project".
    assertSinglePage(issue.projectItems, `projectItems for issue #${n} (ceiling: 20 boards per issue)`);
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

  private async userId(login: string): Promise<string> {
    const data = await this.gql(Q_USER_ID, { login });
    const id = data.user?.id;
    if (!id) throw new ZError(`GitHub user "${login}" not found.`);
    return id;
  }
}

// Line-exact relation-line presence check (F1). Trailing whitespace/CR is
// trimmed (CRLF bodies), then whole lines must match exactly -- substring
// matching made "Depends on #12" satisfy a check for "Depends on #1".
function hasLine(body: string | null | undefined, line: string): boolean {
  return (body ?? "").split("\n").some((l) => l.trimEnd() === line);
}

interface IssueNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  assignees: { nodes: { login: string }[] };
  projectItems: { nodes: { id: string; project: { number: number } | null }[] };
}

// Loud ceiling guard for connections list-shaped queries do NOT paginate
// (nested or bounded lists where cursor-following is impractical from the call
// shape). Silent truncation corrupts board decisions, so overflow throws.
function assertSinglePage(conn: any, what: string): void {
  if (conn?.pageInfo?.hasNextPage) {
    throw new ZError(
      `${what} exceeds its single query page and would be silently truncated -- ` +
        `raise the page size or add pagination in lib/board.ts before proceeding.`
    );
  }
}

function toItem(node: any): BoardItem | null {
  const content = node?.content;
  if (!content || content.number === undefined) return null;
  // fieldValues is nested per-item; overflow past first:20 (5 fields defined on
  // the canonical board) would drop Status/Model/etc. silently.
  assertSinglePage(node.fieldValues, `fieldValues for issue #${content.number} (ceiling: 20 values per item)`);
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
  }
  // Both queries that reach here (Q_PROJECT_ITEMS, Q_FIELD_VALUE) request
  // __typename explicitly, so an unrecognized member is a field type the board
  // does not use -- not a shape to guess a scalar out of.
  return null;
}

function readBody(bodyFile: string): string {
  try {
    return readFileSync(bodyFile, "utf8");
  } catch {
    throw new ZError(`Cannot read --body-file "${bodyFile}".`);
  }
}

// The one process seam ghExecutor spawns through. Injected in tests so the JSON
// body encoding and BOTH error contracts (transport failure; a GraphQL `errors`
// array inside an HTTP-200 body) are exercised on the real executor path with no
// gh, no network. Decodes stdout/stderr to strings here so the default path owns
// the only Buffer handling and fakes are trivial string returns.
export interface GhProc {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export type GhSpawn = (cmd: string[], stdin: string) => GhProc;

const defaultGhSpawn: GhSpawn = (cmd, stdin) => {
  const proc = Bun.spawnSync(cmd, {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
};

// Production executor. This is the only place in the pack's CODE allowed to
// shell to `gh api` directly (grep gate in tests/board.test.ts). Skill .md files
// DO shell out to gh for reads and the planning-pass body edit; every such
// invocation is pinned to an explicit allowlist by the same gate, so a new
// direct call fails it.
//
// We POST to the RAW GraphQL endpoint (`gh api /graphql --input -`) with the
// whole {query, variables} object JSON-encoded on stdin, rather than passing
// variables as `-F k=v`. gh's -F magic typing converts integers, booleans, and
// null but NOT decimal floats: 1.64 reached `Float!` as the string "1.64" and
// the API rejected it, breaking every non-integer NUMBER write -- Estimate
// (1.64, 4.36, ...) and Actual (dollar totals) (issue #17). A JSON body keeps
// every variable its own JSON type, floats included.
//
// The raw endpoint returns HTTP 200 even when the body carries a GraphQL
// `errors` array (the `graphql` subcommand exits non-zero instead), so gh's exit
// code alone would let a failed mutation pass as success. We MUST inspect
// body.errors and throw; the non-zero-exit throw stays for transport failures.
export function ghExecutor(spawn: GhSpawn = defaultGhSpawn): GraphQLExecutor {
  return async (query, variables) => {
    const body = JSON.stringify({ query, variables });
    const proc = spawn(["gh", "api", "/graphql", "--input", "-"], body);
    if (proc.exitCode !== 0) {
      throw new ZError(`gh api /graphql failed: ${proc.stderr.trim()}`);
    }
    // exit 0 does not guarantee a JSON body (e.g. gh printing a plain-text
    // warning to stdout); a raw SyntaxError here would be the one failure path
    // in this executor not surfaced as ZError (issue #23). Snippet is bounded
    // so a huge/binary body doesn't blow up the error message.
    let out: GraphQLData;
    try {
      out = JSON.parse(proc.stdout);
    } catch (e) {
      const snippet = proc.stdout.slice(0, 200);
      throw new ZError(
        `gh api /graphql returned non-JSON stdout: ${(e as Error).message} (stdout: ${JSON.stringify(snippet)})`
      );
    }
    if (Array.isArray(out.errors) && out.errors.length > 0) {
      const e = out.errors[0];
      const where = Array.isArray(e?.path) && e.path.length > 0 ? ` (path: ${e.path.join(".")})` : "";
      throw new ZError(`GraphQL error: ${e?.message ?? JSON.stringify(e)}${where}`);
    }
    return out.data;
  };
}

// -- CLI -------------------------------------------------------------------
const USAGE = `z-board <command> [args]

  list [--status <S>] [--json]      board items with fields (all statuses unless --status)
  snapshot --out-items <F> --out-bodies <F>   all-status items + each ticket's body, one pass (z-loop drain)
  move <N> <S>                      set an issue's Status
  comment <N> --body-file <F>       add a comment
  field-get <N> <Field>             read a custom field (Model | Model Effort | Estimate | Actual)
  field-set <N> <Field> <V>         write a custom field
  create --title T --body-file F --milestone M [--label L]
  link <N> <M>                      record N depends on M (both directions)
  claim <N> <assignee>             atomic assignee claim
  release <N>                      remove every assignee (reconcile a stale claim)
  quota                            remaining GraphQL points

  --slug <name>                     which ~/.zstack/projects/<slug> to use`;

const COMMANDS = new Set([
  "list",
  "snapshot",
  "move",
  "comment",
  "field-get",
  "field-set",
  "create",
  "link",
  "claim",
  "release",
  "quota",
]);

function requireInt(v: string | undefined, label: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n)) {
    throw new ZError(`${label} must be an integer issue number, got "${v}".`);
  }
  return n;
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
        // --status is optional (F0): omitted lists the whole board -- the
        // atomic snapshot z-status consumes as `z-board list --json`. A bare
        // --status with no value is a typo, not a request for everything.
        if ("status" in flags && typeof flags.status !== "string") {
          throw new ZError(`--status requires a value (omit the flag to list all items).`);
        }
        const items = await board.list(str(flags, "status"));
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
      case "snapshot": {
        // One-call drain snapshot (ticket #57): items + bodies to two files, so
        // bin/z-loop-tick never shells to gh and the caller gate holds. Written
        // atomically (tmp+rename) so a crash mid-write can't leave loop.ts
        // ingest a truncated items/bodies file.
        const outItems = requireFlag(flags, "out-items");
        const outBodies = requireFlag(flags, "out-bodies");
        const snap = await board.snapshot();
        atomicWrite(outItems, JSON.stringify(snap.items, null, 2));
        atomicWrite(outBodies, JSON.stringify(snap.bodies));
        console.log(`${snap.items.length} item(s), ${Object.keys(snap.bodies).length} body/ies`);
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
      case "release": {
        const n = requireInt(positionals[0], "issue");
        const removed = await board.release(n);
        console.log(removed.length ? `released #${n} from ${removed.join(", ")}` : `#${n} had no assignees`);
        return 0;
      }
      case "quota": {
        const q = await board.quota();
        console.log(`remaining=${q.remaining} resetAt=${q.resetAt}`);
        return 0;
      }
    }
    // Unreachable: COMMANDS.has(cmd) above already rejected anything the cases
    // below do not cover.
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
