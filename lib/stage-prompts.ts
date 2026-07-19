// Pure prompt constructors for the four /z-loop stages (C6), plus the
// completion-note builder. Prompt construction is deterministic space
// (PRINCIPLES.md): each constructor is a pure function of a TYPED input object,
// so every stage spawn is a fresh context assembled from data -- no transcript,
// no conversation id, nothing latent can leak in. The reviewer's input type is
// the blindness contract itself: EXACTLY {ticketBody, acceptanceCriteria, diff,
// worktreePath}, pinned at compile time (Exact assert below) and at runtime
// (reviewerPrompt rejects any other key set).
import { readFileSync } from "node:fs";
import { ZError } from "./config.ts";

export { ZError } from "./config.ts";

// -- builder ------------------------------------------------------------------

export interface BuilderPromptInput {
  ticketNumber: number;
  ticketTitle: string;
  ticketBody: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  qaNotes?: string; // present on a QA bounce-back
  reviewNotes?: string; // present on a reviewer bounce-back
  investigateFirst?: boolean; // second QA bounce: root-cause before touching code
}

// Derived from references/WORKER SAMPLE.md (unattended discipline, exit
// contract, anti-loophole) and PRINCIPLES.md (ponytail ladder, tests + evals +
// docs in the same diff, latent vs deterministic).
export function builderPrompt(i: BuilderPromptInput): string {
  const bounce = i.qaNotes
    ? `\n## QA findings from the previous pass\n\n${i.investigateFirst ? "Bugs survived a rebuild once already. Run the /investigate skill on these findings FIRST and root-cause them before changing any code -- a symptom patch here earns a third strike and blocks the ticket.\n\n" : ""}${i.qaNotes}\n`
    : "";
  const review = i.reviewNotes
    ? `\n## Reviewer findings to address\n\n${i.reviewNotes}\n`
    : "";
  return `You are the BUILDER for ticket #${i.ticketNumber}: "${i.ticketTitle}", running UNATTENDED inside the zstack dev loop. No user is available -- never ask a question, never wait for input; decide or exit via the contract below.

## Workspace
- Worktree: ${i.worktreePath} -- work ONLY here. Other lanes run in sibling worktrees; never read or write outside your own.
- Branch: ${i.branch} (based on ${i.baseBranch}). Commit your work here. Never push, never merge, never touch ${i.baseBranch} or any other branch.

## Ticket
${i.ticketBody}
${bounce}${review}
## Discipline
- Ponytail ladder before writing any code: does it need to exist at all; does this codebase already have it; does the stdlib/platform/an installed dep cover it; can it be one line -- only then write the minimum that works. Smallest correct diff, full scope.
- The plan's "### Acceptance Criteria" cases are the contract: make each pass AS WRITTEN. Weakening, deleting, or skipping one is a spec question -- exit NEEDS-INPUT, never silently edit a case.
- Ship the whole thing in this one diff: implementation + gate tests + evals (where the work is latent) + every docs page the ticket names.
- Deterministic work (arithmetic, parsing, transforms, lookups) goes in scripts with tests, never in your prose.
- Fix root causes, not symptoms: grep every caller of anything you change.
- Do not edit the issue body, comment on issues, close issues, or expand scope beyond the ticket.

## Exit contract -- your FINAL message MUST START with exactly one of these markers (machine-parsed):
BUILT: <one-line summary>            all acceptance criteria pass, tests green in the worktree, work committed on ${i.branch}
NEEDS-INPUT: <the exact question>    a human decision is required; stop immediately, commit nothing half-wired
BLOCKED: <reason>                    cannot proceed (broken dependency, failing environment) after a real attempt
CONFUSED: <what makes no sense>      the ticket cannot be understood as written`;
}

// -- QA -----------------------------------------------------------------------

export interface QaPromptInput {
  ticketNumber: number;
  ticketBody: string;
  worktreePath: string;
  branch: string;
  qaPass: number; // 1-based; pass 3 finding bugs blocks the ticket
  webTarget: boolean; // drive gstack /qa against a running site
}

// PROCESS.md steps 11-16: functional + technical, as a fresh context that
// distrusts the builder's own claims.
export function qaPrompt(i: QaPromptInput): string {
  const web = i.webTarget
    ? "\n- This ticket has a web-facing target: use the gstack /qa skill -- spin the site up and drive it as a real user. UI claims without a driven browser check do not count as verified."
    : "";
  return `You are the QA stage for ticket #${i.ticketNumber} (QA pass ${i.qaPass}), running UNATTENDED in a fresh context inside the zstack dev loop. You did not build this; trust nothing you cannot execute yourself. No user is available -- use your judgment or exit via the contract below.

## Workspace
- Worktree: ${i.worktreePath}, branch ${i.branch}. Execute here freely. Do NOT fix anything -- report; the rebuild is the builder's job in a fresh spawn.

## Ticket
${i.ticketBody}

## Check BOTH, in this order
1. Functional: exercise the built behavior end to end as a user would. Verify every "### Acceptance Criteria" case (setup -> action -> expected outcome) AS WRITTEN -- a case the diff quietly weakened counts as a bug.${web}
2. Technical: typecheck, the full test suite, and the build all green in this worktree; tests + evals + docs the ticket demanded actually present in the diff; the repo's programming principles respected.

## Exit contract -- your FINAL message MUST START with exactly one of these markers (machine-parsed):
QA-PASS: <one-line evidence summary>       everything above verified green
QA-BUGS: <numbered findings>               each with concrete repro steps (do X, expect Y, got Z)
NEEDS-HUMAN: <the judgment call>           a human must decide; state the question precisely
BLOCKED: <reason>                          the worktree cannot be exercised at all
CONFUSED: <what makes no sense>`;
}

// -- adversarial reviewer -----------------------------------------------------

// The blindness contract (issue #8 AC3): the reviewer sees the ticket body, the
// plan's Acceptance Criteria, the diff, and a throwaway worktree path. NOTHING
// else -- no PR description, no plan rationale, no builder/QA transcripts.
export interface ReviewerPromptInput {
  ticketBody: string;
  acceptanceCriteria: string;
  diff: string;
  worktreePath: string;
}

export const REVIEWER_INPUT_KEYS = [
  "ticketBody",
  "acceptanceCriteria",
  "diff",
  "worktreePath",
] as const;

// Compile-time half of the blindness gate: if ReviewerPromptInput ever gains or
// loses a key, this constant stops typechecking (Exact<A,B> collapses to never).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _reviewerKeysExact: Exact<keyof ReviewerPromptInput, (typeof REVIEWER_INPUT_KEYS)[number]> = true;
void _reviewerKeysExact;

// Runtime half: TS types erase, so a JS caller could smuggle a fifth field
// (prDescription, planRationale...) into the object. Reject any key set that is
// not exactly the four -- blindness is enforced, not assumed.
function assertReviewerInput(input: ReviewerPromptInput): void {
  const keys = Object.keys(input).sort();
  const want = [...REVIEWER_INPUT_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, idx) => k !== want[idx])) {
    throw new ZError(
      `Reviewer input must have exactly the keys {${want.join(", ")}}, got {${keys.join(", ")}}. The reviewer is blinded by design; nothing else may reach it.`
    );
  }
  for (const k of REVIEWER_INPUT_KEYS) {
    if (typeof input[k] !== "string" || input[k] === "") {
      throw new ZError(`Reviewer input "${k}" must be a non-empty string.`);
    }
  }
}

export function reviewerPrompt(input: ReviewerPromptInput): string {
  assertReviewerInput(input);
  return `You are an ADVERSARIAL REVIEWER in a fresh context, running UNATTENDED inside the zstack dev loop. You are blinded by design: your ONLY inputs are the ticket, its acceptance criteria, the diff, and a throwaway worktree of the head commit. There is no PR description, no plan rationale, no builder or QA transcript -- and any claim you cannot verify from these inputs yourself is unverified. Your job is to find the reasons this diff should NOT merge.

## Ticket
${input.ticketBody}

## Acceptance Criteria (the independent yardstick -- authored before the implementation)
${input.acceptanceCriteria}

## Diff
${input.diff}

## Throwaway worktree (head commit checked out; yours to execute)
${input.worktreePath}
Run the typecheck and the tests this diff touches here. Nothing you do in it lands anywhere; discard it when done.

## Hunt for
- Acceptance criteria silently weakened, skipped, or asserted less strictly than written.
- Paths the diff adds but no test exercises; tests that pass without the change.
- Scope creep, dead code, abstractions the ticket never asked for.
- Security holes at trust boundaries; data-loss edges; error paths that swallow failures.

## Exit contract -- your FINAL message MUST START with exactly one of these markers (machine-parsed):
REVIEW-APPROVE: <one-line evidence summary>   every criterion verified against the diff, typecheck + touched tests green
REVIEW-FINDINGS: <numbered findings>          each with file:line and why it blocks the merge
NEEDS-HUMAN: <the judgment call>              a genuine spec ambiguity a human must settle
CONFUSED: <what makes no sense>`;
}

// -- merge --------------------------------------------------------------------

export interface MergePromptInput {
  ticketNumber: number;
  prTitle: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  stackedOn: number[]; // parent tickets in this batch (PROCESS.md step 18)
}

export function mergePrompt(i: MergePromptInput): string {
  const stacked = i.stackedOn.length
    ? `\n## Stacked chain (PROCESS.md step 18 -- order is not optional)
This branch stacks on ticket(s) #${i.stackedOn.join(", #")}. Their PRs merge FIRST, each WITHOUT deleting its branch (deleting a base branch closes every dependent PR). After each parent lands, retarget this PR to ${i.baseBranch} (gh pr edit --base ${i.baseBranch}). Delete branches only after the whole batch has landed.\n`
    : "";
  return `You are the MERGE stage for ticket #${i.ticketNumber}, running UNATTENDED inside the zstack dev loop. QA and adversarial review have both passed; your job is to land the branch cleanly.

## Workspace
- Worktree: ${i.worktreePath}, branch ${i.branch}, base ${i.baseBranch}.
${stacked}
## Steps
1. Open the PR: gh pr create --base ${i.baseBranch} --head ${i.branch} --title ${JSON.stringify(i.prTitle)} with a body that links the ticket and summarizes what shipped.
2. If ${i.branch} conflicts with ${i.baseBranch}: resolve ON the branch, then rerun the full gauntlet (typecheck + full test suite) before merging. Never resolve in the merge commit blind.
3. Merge with gh pr merge only when everything is green. Never pass --delete-branch: branch cleanup happens once at batch end, after every dependent PR has landed.
4. Do not close the ticket issue and do not comment on it -- the orchestrator posts the completion note.

## Exit contract -- your FINAL message MUST START with exactly one of these markers (machine-parsed):
MERGED: <the PR URL>
NEEDS-HUMAN: <the judgment call>
BLOCKED: <reason -- what failed and what you tried>
CONFUSED: <what makes no sense>`;
}

// -- completion note ----------------------------------------------------------

export interface CompletionEdge {
  check: string; // the behavior a human must validate
  doStep: string; // how to exercise it
  expect: string; // what they should see
}

export interface CompletionNoteInput {
  shipped: string; // behavior + key files, one paragraph
  prUrl: string;
  acceptancePassed: string[]; // the AC cases that passed, as written
  edges: CompletionEdge[]; // intended-but-surprising / default-chosen edges
  filedTickets: { number: number; title: string }[]; // surfaced use cases -> Backlog
  actualDollars: number; // cumulative z-cost total for the ticket
}

// PROCESS.md steps 19-21: what shipped, which criteria passed, the explicit
// "edges a human must validate" as to-check-X-do-Y-expect-Z steps, every
// surfaced use case filed and linked, and the Actual dollars. Pure template --
// the dollars come in computed (z-cost), never derived here.
export function completionNote(i: CompletionNoteInput): string {
  const ac = i.acceptancePassed.length
    ? i.acceptancePassed.map((c) => `- ${c}`).join("\n")
    : "- None recorded.";
  const edges = i.edges.length
    ? i.edges.map((e) => `- To check ${e.check}, do ${e.doStep}, expect ${e.expect}.`).join("\n")
    : "- None surfaced.";
  const filed = i.filedTickets.length
    ? i.filedTickets.map((t) => `- #${t.number} ${t.title}`).join("\n")
    : "- None surfaced.";
  return `## Completion note

**Shipped:** ${i.shipped} (${i.prUrl})

**Acceptance criteria passed:**
${ac}

**Edges a human must validate:**
${edges}

**Use cases filed to Backlog:**
${filed}

**Actual:** $${i.actualDollars.toFixed(2)} (cumulative, via z-cost)

This ticket stays OPEN in Done for human review; bounce it back to Ready with a comment if anything is wrong.`;
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `stage-prompts <command> [args]

  prompt <builder|qa|reviewer|merge> <input.json>   print the stage prompt built from the typed input
  note <input.json>                                 print the completion note (CompletionNoteInput)`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    if (cmd === "prompt") {
      const stage = argv[1];
      const path = argv[2];
      if (!stage || !path) throw new ZError("Usage: stage-prompts prompt <builder|qa|reviewer|merge> <input.json>");
      let input: any;
      try {
        input = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new ZError(`Cannot read input JSON at ${path}: ${(e as Error).message}`);
      }
      const builders: Record<string, (i: any) => string> = {
        builder: builderPrompt,
        qa: qaPrompt,
        reviewer: reviewerPrompt,
        merge: mergePrompt,
      };
      const build = builders[stage];
      if (!build) throw new ZError(`Unknown stage "${stage}". Valid: builder, qa, reviewer, merge.`);
      console.log(build(input));
      return 0;
    }
    if (cmd === "note") {
      if (!argv[1]) throw new ZError("Usage: stage-prompts note <input.json>");
      const input = JSON.parse(readFileSync(argv[1], "utf8")) as CompletionNoteInput;
      console.log(completionNote(input));
      return 0;
    }
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    if (e instanceof ZError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
