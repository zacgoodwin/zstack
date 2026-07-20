// Board double for the /z-plan backlog-scan eval (issue #25). Serves
// `fixture-backlog-ticket.md` as the sole Backlog item so `/z-plan --backlog
// --dry-run` (and its Step 0 preconditions) run with zero network and no live
// GitHub project.
//
// Why this fakes `gh` rather than `lib/board.ts`'s GraphQLExecutor: z-board's
// ghExecutor() (lib/board.ts) shells the literal argv `gh api /graphql
// --input -`, and z-plan/SKILL.md also shells `gh repo view` / gh's
// issue-view subcommand directly (Step 0's slug lookup, Step 10's body fetch)
// -- two call paths, one seam. Faking the `gh` binary covers both without
// touching lib/board.ts or
// the skill text (both out of scope for this ticket, and lib/board.ts is a
// sibling lane's file this build must not edit). This mirrors the exact
// fixture-routing pattern tests/board.test.ts's makeExecutor() uses for
// lib/board.ts's GraphQLExecutor (route by GraphQL operation name), just one
// layer further out.
//
// run.sh wires this in by writing a tiny `gh` shell shim onto PATH that execs
// `bun board-double.ts "$@"` (see run.sh's backlog case) -- see run.md for the
// full wiring, including the real (non-mocked) run's remaining prerequisite
// (a ~/.zstack/projects/<slug>/config.json for Step 0's quota precondition).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BoardDoubleFixture {
  slug: string; // stands in for `gh repo view --json name -q .name`
  issueNumber: number; // the sole Backlog item's issue number
  body: string; // fixture-backlog-ticket.md contents
}

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const ok = (stdout: string): GhResult => ({ exitCode: 0, stdout, stderr: "" });
const okErr = (stderr: string): GhResult => ({ exitCode: 0, stdout: "", stderr });
const fail = (stderr: string): GhResult => ({ exitCode: 1, stdout: "", stderr });

// Matches a GraphQL operation's name the same way tests/board.test.ts's
// opName() does, so routing here stays consistent with the real fixture-
// router's convention.
function opName(query: string): string {
  const m = query.match(/(?:query|mutation)\s+(\w+)/);
  return m ? m[1] : "";
}

// The board's ProjectItems shape (lib/board.ts's Q_PROJECT_ITEMS), with the
// fixture ticket as the sole node, Status = Backlog, no other fields set (it
// is an unplanned brain-dump -- Model/Model Effort/Estimate are all absent,
// exactly as Step 10 expects to find them before it fields the ticket).
function projectItemsData(fx: BoardDoubleFixture): unknown {
  return {
    node: {
      items: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            content: {
              number: fx.issueNumber,
              title: "Backlog fixture ticket",
              url: `https://github.com/${fx.slug}/issues/${fx.issueNumber}`,
            },
            fieldValues: {
              nodes: [
                {
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  name: "Backlog",
                  field: { name: "Status" },
                },
              ],
            },
          },
        ],
      },
    },
  };
}

function routeGraphQL(query: string, fx: BoardDoubleFixture): unknown {
  const op = opName(query);
  switch (op) {
    case "RateLimit":
      // Healthy quota, far in the future: Step 0's `z-board quota` precondition
      // and the guard inside every gql() call both pass with no sleep/abort.
      return { rateLimit: { remaining: 5000, resetAt: "2099-01-01T00:00:00Z" } };
    case "ProjectItems":
      return projectItemsData(fx);
    default:
      // A read-only --dry-run --backlog pass never issues a write mutation
      // (SetSingleSelect/SetNumber/SetText/AddComment/UpdateIssueBody) -- one
      // showing up here means the pass regressed into a real board write.
      // Fail loudly instead of faking a silent success that would mask it.
      throw new Error(
        `board-double: unexpected GraphQL operation "${op || "(unnamed)"}" in a read-only --dry-run --backlog pass`
      );
  }
}

// argv is the invocation AFTER the leading "gh" (i.e. process.argv.slice(2)
// for the CLI below, or argv[1:] for a caller that already stripped it).
export function handleGh(argv: string[], stdin: string, fx: BoardDoubleFixture): GhResult {
  const [cmd, sub, ...rest] = argv;

  if (cmd === "repo" && sub === "view") {
    // Only the exact invocation z-plan/SKILL.md uses is supported
    // (`gh repo view --json name -q .name`) -- anything else is unexpected
    // drift in the skill's gh usage, not silently guessed at.
    if (rest.includes("name")) return ok(`${fx.slug}\n`);
    return fail(`board-double: unsupported "gh repo view" invocation: ${argv.join(" ")}\n`);
  }

  if (cmd === "auth" && sub === "status") {
    // Real `gh auth status` writes to stderr; the skill's probe greps stderr
    // for the "project" scope (z-loop/SKILL.md Step 1), so echo that shape.
    return okErr("Logged in to github.com\n✓ Token scopes: 'project', 'repo'\n");
  }

  if (cmd === "issue" && sub === "view") {
    const n = Number(rest.find((a) => !a.startsWith("-")));
    if (n === fx.issueNumber) return ok(fx.body);
    return fail(`board-double: no such issue #${n} (fixture only knows #${fx.issueNumber})\n`);
  }

  if (cmd === "api") {
    if (sub !== "/graphql") {
      return fail(`board-double: unsupported "gh api" invocation: ${argv.join(" ")}\n`);
    }
    let parsed: { query?: string; variables?: Record<string, unknown> };
    try {
      parsed = JSON.parse(stdin);
    } catch (e) {
      return fail(`board-double: gh api stdin is not valid JSON: ${(e as Error).message}\n`);
    }
    if (typeof parsed.query !== "string") {
      return fail(`board-double: gh api stdin has no "query" string.\n`);
    }
    try {
      const data = routeGraphQL(parsed.query, fx);
      return ok(JSON.stringify({ data }));
    } catch (e) {
      return fail(`${(e as Error).message}\n`);
    }
  }

  return fail(`board-double: unhandled gh invocation: gh ${argv.join(" ")}\n`);
}

// -- CLI ----------------------------------------------------------------------
function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return ""; // no piped stdin (e.g. `gh repo view`, which never reads it)
  }
}

function loadFixture(): BoardDoubleFixture {
  const bodyFile =
    process.env.ZPLANNER_DOUBLE_BODY_FILE ?? join(import.meta.dir, "fixture-backlog-ticket.md");
  return {
    slug: process.env.ZPLANNER_DOUBLE_SLUG ?? "zstack-planner-eval",
    issueNumber: Number(process.env.ZPLANNER_DOUBLE_ISSUE ?? "501"),
    body: readFileSync(bodyFile, "utf8"),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // Only the `api` subcommand's stdin is ever read (--input -); reading stdin
  // unconditionally would hang the other subcommands when none is piped.
  const stdin = argv[0] === "api" ? readStdinSync() : "";
  const result = handleGh(argv, stdin, loadFixture());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
