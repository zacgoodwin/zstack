// Pure prompt constructors for the four /z-loop stages (C6), plus the
// completion-note builder. Prompt construction is deterministic space
// (PRINCIPLES.md): each constructor is a pure function of a TYPED input object,
// so every stage spawn is a fresh context assembled from data -- no transcript,
// no conversation id, nothing latent can leak in. The reviewer's input type is
// the blindness contract itself: EXACTLY {ticketBody, acceptanceCriteria, diff,
// worktreePath}, pinned at compile time (Exact assert below) and at runtime
// (reviewerPrompt rejects any other key set).
//
// POINTER PROMPTS (ticket #57, Leak 1): each constructor takes a SECOND arg,
// `inputPath` -- the absolute path of the stage's input-<N>.json -- and inlines
// only the small/fixed fields (numbers, title, worktree, branch, flags) plus the
// discipline/exit-contract boilerplate. The large payload (ticketBody, diff,
// acceptanceCriteria) is NOT embedded; the prompt tells the worker to read those
// fields FROM inputPath. So the printed prompt is size-invariant to the payload,
// and the orchestrator reading it back to spawn the Agent never holds the
// ticket's body/diff in its own context. `inputPath` is a plain function
// parameter, NOT a key of the input object, so the reviewer's exact-four-key
// blindness gate is untouched.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleCliError } from "./cli.ts";
import { ADVERSARIAL_MODES, DEFAULT_ADVERSARIAL_MODE, ZError, type AdversarialMode } from "./config.ts";

export { ZError } from "./config.ts";
// Re-exported so importers of this module get the enum from the one file that
// owns the prompt-side adversarial helpers (config.ts is the definitional home).
export type { AdversarialMode } from "./config.ts";

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

// Derived from docs/user-guide/spec/WORKER SAMPLE.md (unattended discipline, exit
// contract, anti-loophole) and PRINCIPLES.md (ponytail ladder, tests + evals +
// docs in the same diff, latent vs deterministic).
export function builderPrompt(i: BuilderPromptInput, inputPath: string): string {
  const bounce = i.qaNotes
    ? `\n## QA findings from the previous pass\n\n${i.investigateFirst ? "Bugs survived a rebuild once already. Run the /investigate skill on these findings FIRST and root-cause them before changing any code -- a symptom patch here earns a third strike and blocks the ticket.\n\n" : ""}Read the findings you must address from \`qaNotes\` in ${inputPath}.\n`
    : "";
  const review = i.reviewNotes
    ? `\n## Reviewer findings to address\n\nRead them from \`reviewNotes\` in ${inputPath}.\n`
    : "";
  return `You are the BUILDER for ticket #${i.ticketNumber}: "${i.ticketTitle}", running UNATTENDED inside the zstack dev loop. No user is available -- never ask a question, never wait for input; decide or exit via the contract below.

## Workspace
- Worktree: ${i.worktreePath} -- work ONLY here. Other lanes run in sibling worktrees; never read or write outside your own.
- Branch: ${i.branch} (based on ${i.baseBranch}). Commit your work here. Never push, never merge, never touch ${i.baseBranch} or any other branch.

## Ticket
Read your full ticket body (Context, Plan, Acceptance Criteria, Tests + evals, Docs pages touched, Out of scope) from ${inputPath} -- field \`ticketBody\` -- before doing anything else. That body is the contract for this build.
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
export function qaPrompt(i: QaPromptInput, inputPath: string): string {
  const web = i.webTarget
    ? "\n- This ticket has a web-facing target: use the gstack /qa skill -- spin the site up and drive it as a real user. UI claims without a driven browser check do not count as verified."
    : "";
  return `You are the QA stage for ticket #${i.ticketNumber} (QA pass ${i.qaPass}), running UNATTENDED in a fresh context inside the zstack dev loop. You did not build this; trust nothing you cannot execute yourself. No user is available -- use your judgment or exit via the contract below.

## Workspace
- Worktree: ${i.worktreePath}, branch ${i.branch}. Execute here freely. Do NOT fix anything -- report; the rebuild is the builder's job in a fresh spawn.

## Ticket
Read the ticket body -- Context, Plan, and especially every "### Acceptance Criteria" case -- from ${inputPath}, field \`ticketBody\`, before you start.

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

// The trigger labels the "non-trivial" mode escalates on regardless of diff
// size (issue #59): a one-line change to any of these blast-radius surfaces
// still earns the skeptic fan-out. Labels live on the GitHub issue and are
// fetched at reviewer-spawn time (SKILL.md), never ingested into board state.
export const ADVERSARIAL_TRIGGER_LABELS = ["security", "migration", "payments", "auth"] as const;

// The "non-trivial" mode's diff-size threshold (>= this many changed lines fans
// out). Named so the boundary is one constant, not a literal buried in a branch.
export const ADVERSARIAL_DIFF_THRESHOLD = 10;

// Changed-line count of a unified diff: lines added or removed, excluding the
// +++/--- file headers. The blast-radius proxy the "non-trivial" mode gates on.
// Deterministic space (PRINCIPLES.md): line-counting is code, never model work.
export function countDiffLines(diff: string): number {
  return diff.split(/\r?\n/).filter(
    (l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")
  ).length;
}

// Pure activation predicate: does this card's Review stage fan out skeptics?
// off -> never; always -> always; non-trivial -> diff >= threshold OR any
// trigger label. A pure function of (mode, size, labels) so it is gate-testable
// with no live agent (AC1-5); set-intersection over labels is code, not model
// work.
export function adversarialActive(mode: AdversarialMode, diffLineCount: number, labels: string[]): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  const trig = new Set<string>(ADVERSARIAL_TRIGGER_LABELS);
  return diffLineCount >= ADVERSARIAL_DIFF_THRESHOLD || labels.some((l) => trig.has(l));
}

// Two independent SECOND/THIRD params, never input keys -- the four-key
// blindness gate (assertReviewerInput) fires first and is unchanged, so neither
// the pointer path nor the mode/labels that decided `adversarial` ever reach the
// reviewer as data. `inputPath` (ticket #57) makes the prompt a pointer: the
// large payload (ticketBody, acceptanceCriteria, diff) is read FROM the file,
// never embedded, so the printed prompt is size-invariant. `adversarial` (#59):
// false is the single pass, still carrying REVIEW-APPROVE's unconditional
// confidence=<0-100> token (#62's safety gate reads it either way); true
// additionally folds in the super-truth skeptic fan-out and stamps the same
// token onto REVIEW-FINDINGS too. The token rides inside the marker's note, so
// loop.ts's marker regex parses it unchanged regardless of branch.
export function reviewerPrompt(input: ReviewerPromptInput, inputPath: string, adversarial: boolean = false): string {
  assertReviewerInput(input);
  // ponytail: N=3 skeptics is a fixed ceiling (no config knob this ticket); a
  // per-project skeptic count is a follow-on if 3 proves too few/many.
  const superTruth = adversarial
    ? `
## Super-truth pass (adversarial mode active)
This card's blast radius earned an adversarial review; do NOT trust your single read. Spawn 3 INDEPENDENT skeptic sub-agents with the Agent tool -- nested \`claude -p\` is denied by the classifier, so use the Agent tool, not headless claude. Give each skeptic ONLY the four inputs you were given (this ticket, the acceptance criteria, the diff, the throwaway worktree); they are blinded exactly as you are. Task each one to REFUTE that the diff satisfies the acceptance criteria: find the one criterion it violates, the edge it breaks, a test that passes without the change. They work in isolation -- no skeptic sees another's verdict.
Reconcile the three verdicts into an aggregated confidence 0-100: the percentage of skeptics that could NOT refute the diff (3/3 unrefuted = 100, 2/3 = 67, 1/3 = 33, 0/3 = 0). A criterion any skeptic refutes with concrete evidence is a finding, not a vote to be outnumbered -- surface it. Report the confidence in your exit marker below.
`
    : "";
  // REVIEW-FINDINGS' confidence token rides inside the marker's note only on
  // the super-truth pass (#59's aggregation); findings already bounce to the
  // builder regardless of any score, so parsing/logging it there is out of
  // #62's scope. REVIEW-APPROVE is different: #62's safety gate reads it
  // unconditionally, so that marker always carries the literal
  // confidence=<0-100> token below -- self-assessed on a single pass,
  // aggregated across skeptics when the super-truth pass ran.
  const conf = adversarial ? "confidence=<0-100> " : "";
  return `You are an ADVERSARIAL REVIEWER in a fresh context, running UNATTENDED inside the zstack dev loop. You are blinded by design: your ONLY inputs are the ticket, its acceptance criteria, the diff, and a throwaway worktree of the head commit. There is no PR description, no plan rationale, no builder or QA transcript -- and any claim you cannot verify from these inputs yourself is unverified. Your job is to find the reasons this diff should NOT merge.

## Your inputs (read from the file -- do not look anywhere else)
Read \`ticketBody\`, \`acceptanceCriteria\`, and \`diff\` from ${inputPath}. That file holds EXACTLY those three fields plus this worktree path and nothing else -- no PR description, no plan rationale, no builder or QA transcript reaches you. The acceptance criteria are the independent yardstick, authored before the implementation; hold the diff to them as written.

## Throwaway worktree (head commit checked out; yours to execute)
${input.worktreePath}
Run the typecheck and the tests this diff touches here. Nothing you do in it lands anywhere; discard it when done.

## Hunt for
- Acceptance criteria silently weakened, skipped, or asserted less strictly than written.
- Paths the diff adds but no test exercises; tests that pass without the change.
- Scope creep, dead code, abstractions the ticket never asked for.
- Security holes at trust boundaries; data-loss edges; error paths that swallow failures.
${superTruth}
## Exit contract -- your FINAL message MUST START with exactly one of these markers (machine-parsed):
REVIEW-APPROVE: confidence=<0-100> <one-line evidence summary>   every criterion verified against the diff, typecheck + touched tests green -- confidence is your certainty every criterion holds (aggregated per the super-truth pass above when it ran); a score below the project's configured floor will NOT merge
REVIEW-FINDINGS: ${conf}<numbered findings>          each with file:line and why it blocks the merge
NEEDS-HUMAN: <the judgment call>              a genuine spec ambiguity a human must settle
BLOCKED: <reason>                             the throwaway worktree is unusable -- can't check out or execute the diff at all
CONFUSED: <what makes no sense>`;
}

// -- merge --------------------------------------------------------------------

// POSIX single-quote escaping for a value that lands inside a bash command the
// merge agent will run. Wrap in single quotes and rewrite each embedded single
// quote as '\'' (close-quote, escaped-quote, reopen-quote). Inside single
// quotes bash performs NO expansion, so $(...), backticks, and $VARS in a
// spec-derived PR title stay inert literals instead of executing when the agent
// runs `gh pr create --title <here>`. JSON.stringify would double-quote it,
// leaving those metacharacters live -- a title like `Fix $(cmd) parsing` would
// execute cmd.
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface MergePromptInput {
  ticketNumber: number;
  prTitle: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  stackedOn: number[]; // parent tickets in this batch (PROCESS.md step 18)
}

export function mergePrompt(i: MergePromptInput, inputPath: string): string {
  const stacked = i.stackedOn.length
    ? `\n## Stacked chain (PROCESS.md step 18 -- order is not optional)
This branch stacks on ticket(s) #${i.stackedOn.join(", #")}. Their PRs merge FIRST, each WITHOUT deleting its branch (deleting a base branch closes every dependent PR). After each parent lands, retarget this PR to ${i.baseBranch} (gh pr edit --base ${i.baseBranch}). Delete branches only after the whole batch has landed.\n`
    : "";
  return `You are the MERGE stage for ticket #${i.ticketNumber}, running UNATTENDED inside the zstack dev loop. QA and adversarial review have both passed; your job is to land the branch cleanly.

## Workspace
- Worktree: ${i.worktreePath}, branch ${i.branch}, base ${i.baseBranch}.
- Full stage input (numbers, PR title, branch, base, worktree, stacked chain) is in ${inputPath} if you need to re-read any field.
${stacked}
## Steps
1. Open the PR: gh pr create --base ${i.baseBranch} --head ${i.branch} --title ${shSingleQuote(i.prTitle)} with a body that links the ticket and summarizes what shipped.
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

  prompt <builder|qa|merge> <input.json>            print the stage prompt built from the typed input
  prompt reviewer <input.json> [--adversarial-mode <off|non-trivial|always>] [--labels <json-array>]
                                                    print the reviewer prompt; the flags decide the
                                                    super-truth fan-out deterministically (diff size + labels + mode)
  note <input.json>                                 print the completion note (CompletionNoteInput)`;

// A single "--flag value" lookup for the reviewer's two optional flags. Returns
// the token after the flag, or undefined when the flag is absent (defaults apply).
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

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
      if (stage === "reviewer") {
        // The reviewer is the one stage whose prompt needs more than its input
        // file: adversarial activation is a deterministic function of the
        // configured mode, the diff's OWN changed-line count, and the card's
        // labels. Mode + labels arrive as FLAGS, never as a fifth input key --
        // the blinded four-key input-<N>.json is untouched (blindness intact).
        const modeArg = flagValue(argv, "--adversarial-mode");
        const mode = (modeArg ?? DEFAULT_ADVERSARIAL_MODE) as AdversarialMode;
        if (!ADVERSARIAL_MODES.includes(mode)) {
          throw new ZError(
            `--adversarial-mode must be one of "off", "non-trivial", "always", got ${JSON.stringify(modeArg)}.`
          );
        }
        let labels: string[] = [];
        const labelsArg = flagValue(argv, "--labels");
        if (labelsArg !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(labelsArg);
          } catch (e) {
            throw new ZError(`--labels must be a JSON array of strings, got ${JSON.stringify(labelsArg)}: ${(e as Error).message}`);
          }
          if (!Array.isArray(parsed) || parsed.some((l) => typeof l !== "string")) {
            throw new ZError(`--labels must be a JSON array of strings, got ${JSON.stringify(labelsArg)}.`);
          }
          labels = parsed as string[];
        }
        // countDiffLines runs on the input's own diff BEFORE reviewerPrompt's
        // assertReviewerInput; guard a missing diff so activation computes, then
        // the four-key gate throws the real "blinded by design" error.
        const active = adversarialActive(mode, countDiffLines(typeof input.diff === "string" ? input.diff : ""), labels);
        // Pointer prompt (ticket #57): reviewer reads its payload from the input
        // file by ABSOLUTE path; the flag-derived `active` selects the fan-out.
        console.log(reviewerPrompt(input, resolve(path), active));
        return 0;
      }
      const builders: Record<string, (i: any, inputPath: string) => string> = {
        builder: builderPrompt,
        qa: qaPrompt,
        merge: mergePrompt,
      };
      const build = builders[stage];
      if (!build) throw new ZError(`Unknown stage "${stage}". Valid: builder, qa, reviewer, merge.`);
      // The pointer prompt references this input file by ABSOLUTE path, so the
      // worker (a fresh Agent with its own CWD) resolves it unambiguously.
      console.log(build(input, resolve(path)));
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
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
