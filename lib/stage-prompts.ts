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
import { dirname, join, resolve } from "node:path";
import { handleCliError, parseFlags, str } from "./cli.ts";
import {
  ADVERSARIAL_MODES,
  DEFAULT_ADVERSARIAL_MODE,
  DEFAULT_STAGE_WATCHDOG_MINUTES,
  ZError,
  type AdversarialMode,
} from "./config.ts";
// Type-only: erased at build, so this cannot introduce a runtime cycle (and
// lib/loop.ts imports nothing from here -- it only names this module in prose).
import type { Stage } from "./loop.ts";
// #323: the exit contract is a verdict FILE, and its instruction text is owned
// by the module that READS the file (lib/verdict.ts), so writer and reader can
// never drift. verdict.ts imports nothing from here; no cycle.
import { verdictInstructions, verdictPath, type ExpectedSpawn } from "./verdict.ts";

// The spawn identity + artifact paths every constructor needs since #323: the
// verdict file it must tell the stage to write, and the spawn coordinates that
// go INSIDE that file's envelope. `skepticDirs` is reviewer-only -- the three
// pre-computed skeptic artifact directories whose verdict paths the briefs
// name (composed by the orchestrator off `transcripts dest`, never by the
// reviewer, which is #265's enforceability).
export interface VerdictTarget {
  path: string; // the stage's own verdict.json (verdict.ts `path` verb)
  runId: string;
  ticket: number;
  attempt: number;
  skepticDirs?: string[];
}

// The opacity boundary (#190/#322): the runId and attempt are stamped into the
// verdict ENVELOPE the stage copies, which unavoidably tells a reviewer its
// attempt number. That was weighed: the blindness contract's four-key input is
// untouched (VerdictTarget is a constructor parameter, never an input key),
// and a verdict file that cannot name its spawn cannot be validated against
// it -- mis-addressed verdicts were exactly how attempts collided (#210). The
// diff/AC/ticket the reviewer judges still carry no prior-review narrative.
function spawnFor(t: VerdictTarget, stage: "builder" | "qa" | "reviewer" | "merge" | "skeptic"): ExpectedSpawn {
  return { runId: t.runId, ticket: t.ticket, stage, attempt: t.attempt };
}

// Wiring-bug tripwire for the stages whose input also names the ticket: a
// VerdictTarget composed for another lane must never stamp this lane's prompt.
function assertTicketMatch(t: VerdictTarget, ticketNumber: number): void {
  if (t.ticket !== ticketNumber) {
    throw new ZError(`VerdictTarget is for ticket #${t.ticket} but this prompt is for #${ticketNumber}.`);
  }
}

// The four stages as a runtime list, for CLI validation. Kept beside the
// type-only import so a change to the union fails typecheck here.
export const STAGES: readonly Stage[] = ["builder", "qa", "reviewer", "merge"] as const;

// Re-exported so importers of this module get the enum from the one file that
// owns the prompt-side adversarial helpers (config.ts is the definitional home).
export type { AdversarialMode } from "./config.ts";

// -- spawn tag (#190) ----------------------------------------------------------

// The orchestrator never learns the agent id the harness assigns to a spawn, so
// a stage's own transcript is only findable by a token guaranteed to appear in
// its first user message. This is that token's marker; lib/transcripts.ts
// searches for it. Defined HERE, in the module that emits it, so the format has
// exactly one definition (the reader imports this constant).
export const SPAWN_TAG_MARKER = "zstack-spawn:";

// One inert line, prepended to every stage prompt when a tag is supplied. An
// HTML comment so no worker reads it as an instruction, and FIRST so the reader
// finds it inside a bounded prefix of the transcript's opening line instead of
// loading a multi-megabyte file.
//
// Omitted (or empty) renders "", which keeps every prompt BYTE-IDENTICAL to
// pre-#190 -- that is what lets tests/reviewer-single-pass.golden.txt stand
// unregenerated, and it is a positional scalar arg, never an input key, so the
// reviewer's exact-four-key blindness gate is untouched. The tag's own value is
// an opaque digest for the same reason (see spawnTag in lib/transcripts.ts): a
// readable <slug>/t<n>/<stage>/<attempt> would tell the blinded reviewer which
// review ATTEMPT this is.
function spawnStamp(tag: string | undefined): string {
  return tag ? `<!-- ${SPAWN_TAG_MARKER} ${tag} (orchestrator bookkeeping; ignore) -->\n` : "";
}

// -- spawn stub (Leak 3) -------------------------------------------------------

// #57 made the stage prompt size-invariant to its PAYLOAD (ticketBody/diff/AC
// live in input-<N>.json and the prompt only points at them). It did not make
// the orchestrator's context size-invariant to the PROMPT: the orchestrator
// still read prompt-<N>.txt back and re-sent all ~2.9 KB of it as the Agent
// spawn's `prompt` param, so every stage's full instruction text landed in the
// long-lived orchestrator window TWICE (once as the read result, once as the
// tool-call param) and then rode in every later turn's cache read for the rest
// of the drain. Measured over 35 real drains: 568 spawns x ~2,874 chars =
// 1.63 MB of param text plus 302 KB of read-back, ~8% of all orchestrator input
// tokens, for text the orchestrator never reasons about.
//
// The stub is the same pointer trick applied one level up: the orchestrator
// sends only a path, and the worker reads its own instructions. The stub's
// length depends on the stage name, the tag, and the path -- never on the
// prompt -- which is the property the eval and gate test pin.
//
// The tag (#190) moves here BECAUSE the stub, not the prompt, is now the
// worker's first user message, and lib/transcripts.ts finds a spawn by scanning
// a bounded prefix of that opening line. Leaving it only on the prompt file
// would silently orphan every stage transcript.
//
// The explicit BLOCKED fallback is the failure mode that matters: an unreadable
// prompt file must surface as a parseable outcome recordOutcome already handles
// (the lane bounces or parks, loudly), never as a worker improvising a build
// with no instructions or stalling until the watchdog fires.
export function spawnStub(stage: Stage, promptPath: string, tag?: string): string {
  return `${spawnStamp(tag)}You are the ${stage.toUpperCase()} stage of the zstack dev loop, running UNATTENDED in a fresh context. No user is available.

Read this file NOW, before anything else, and follow it exactly. It is your complete instructions -- workspace, ticket, discipline, and the exit contract your final message must satisfy:
${promptPath}

If you cannot read it, do nothing else and make your final message exactly:
BLOCKED: could not read stage prompt at ${promptPath}`;
}

// -- shared stage rules --------------------------------------------------------

// #209, gap 2. The stage prompts told the worker to run the gauntlet and never
// said the run must FINISH before the marker, and the loop sends a stage agent
// exactly one message by design ("One fresh agent per stage. Never reuse or
// SendMessage a previous stage's agent") -- so an agent that backgrounds `bun
// test` and stops to wait can never be woken. Run 11's #170 builder did exactly
// that: it fixed both reviewer findings, backgrounded the suite, and ended its
// turn saying it would finalize once the run landed. A markerless final message
// parses as CONFUSED, so that lane was one recorded outcome away from being
// skipped with the finished diff sitting uncommitted in its worktree.
//
// Shared verbatim by all three judging stages. The REVIEWER carries it too, and
// that is where the observed damage actually is: reviewers were 3 of run 11's 4
// markerless exits, and run 12 reproduced it three more times (#149, #178, #205
// each ended a turn with no marker while waiting on skeptics, each needing a
// manual resume to avoid being parsed as CONFUSED and skipped). The reviewer runs
// the same typecheck-and-touched-tests gauntlet in its throwaway worktree, and
// #191's super-truth block only covers the skeptic half of the wait -- so the
// generic rule goes to all three and the single-pass reviewer's golden file was
// regenerated rather than protected. Merge is excluded: it runs `gh pr merge`,
// not a gauntlet, and H9 already refuses to blind-skip a dead merge worker.
//
// (#323 note: "parsed as CONFUSED" became "read as a dead stage" above -- a
// missing or invalid verdict file routes to the respawn-then-salvage machinery,
// never a silent skip. The affordability sentence and the one-message design
// are unchanged.)
//
// #307 added the affordability sentence, which is why this is a function of the
// stage rather than one constant. Run 16's #286 builder backgrounded `bun test`
// and ended its turn to await the completion notification -- the rule above told
// it not to, but never told it that waiting in the foreground FITS. The suite is
// 128-234s measured against a 25-minute builder budget, so the numbers are the
// argument.
//
// The minutes come from DEFAULT_STAGE_WATCHDOG_MINUTES, the one definition of the
// budget, and are stated as the DEFAULT because a project can override
// `watchdogMinutes` and these constructors are not handed config today. That is a
// choice, not a constraint -- the `prompt` CLI verb below already takes
// config-derived flags (--adversarial-mode, --labels) and a resolved budget could
// ride in the same way. It costs nothing today because a live agent is probed
// alive rather than killed at the bound, so an over-generous number in the prompt
// never loses work; the day the watchdog kills on age, thread the resolved value.
//
// ponytail: "128-234s" is a literal here, matching the ~11 existing copies of the
// measurement across z-loop/SKILL.md, docs/user-guide/z-loop.md, lib/lanes.ts and
// the CHANGELOG. No constant owns it. The ceiling: one measured-runtime constant
// every consumer (including MERGE_GATE_BUDGET_MS, already derived from it) reads,
// so re-measuring moves one number. Out of #307's scope -- it would touch every
// copy -- and the gate test below pins only the string, so a stale figure here
// fails no test.
function foregroundRule(stage: Stage): string {
  return `## Verification runs in the FOREGROUND
Every command you verify with -- the test suite, typecheck, build, anything you would cite as evidence -- must run to completion IN THE FOREGROUND before you write your verdict file. Never background a gate and end your turn waiting on it: no one will wake you (this loop sends a stage agent exactly one message, by design), so the run's result reaches nobody. The same goes for anything else you are waiting on, a sub-agent included: report what you actually hold. Ending your turn with a background job still pending and no verdict file written is read as a dead stage -- your work is inspected, but your judgment of it is lost. Waiting is affordable: this repo's full suite runs 128-234s measured, against the ${DEFAULT_STAGE_WATCHDOG_MINUTES[stage]} minutes of silence your stage's watchdog allows by default. If a check is too slow to finish, write the verdict naming what you actually ran and what you did not.`;
}

// #307, the other half. Every exit contract already said the marker must be the
// FIRST line; two haiku stages in run 16 wrote a prose summary and closed with a
// correctly spelled `BUILT:` / `QA-PASS:` anyway, and both tickets were skipped
// with the work committed and green. lib/loop.ts now reads a marker on a line of
// its own wherever it sits rather than losing the ticket, but the CONTRACT does not
// loosen and the prompt deliberately does not advertise that. The parser's leniency
// is a NET, not the spec: a quoted marker (fenced, or still carrying this
// placeholder) is not read at all, two different markers below line 1 are still
// CONFUSED, and only a line-1 marker is guaranteed unambiguous. An agent told "any
// line will do" aims at the loose target and lands in the cases the net misses. So
// the rule is restated with the exact failing shape as a worked negative example --
// positive templates alone were demonstrably not sticky enough.
//
// `example` is the stage's own success marker, so the negative example names the
// token that stage would actually have gotten wrong. Placed LAST in every prompt,
// after the marker list, because that is the closing instruction the agent reads
// immediately before acting on it.
//
// #318 added the unconditional half. Position was stated as a contract; EXISTENCE
// was only ever implied by "your FINAL message MUST START with one of these", and
// an agent that believes its work is unfinished does not read that as binding --
// it reads it as describing the finished case and stops short of it. Every
// markerless exit in the corpus has this shape: the stage was waiting on something
// (a backgrounded suite in #170/#286, backgrounded skeptics in #149/#178/#205 and
// again in loop 17's #192/#207) and treated silence as the honest report of an
// incomplete run. It is the opposite: silence parses as CONFUSED, which SKIPS the
// ticket and discards work that is usually finished, committed and green. So the
// closer now says the marker is unconditional and names the two markers that exist
// precisely for the paths that went wrong, since "I have no verdict" needs a
// sanctioned way to be said or it gets said by saying nothing. Shared by all four
// stages -- every one of them can be mid-something when its budget runs out.
// (#307/#318's markerPositionRule lived here until #323: position and
// existence rules for a marker LINE stop mattering when the verdict is a file.
// The every-path-out-carries-a-verdict half of that hard-won lesson survives
// inside lib/verdict.ts's verdictInstructions, which every prompt renders.)

// #209: the briefing a stage gets when it is a RE-SPAWN of a worker that died
// without ever reporting. Its predecessor's changes are still in the worktree,
// and the judgment call is handed over explicitly: carrying them forward as
// trusted would defeat the fresh-agent guarantee (nothing verified them), and
// dropping them silently is the waste the re-spawn exists to prevent. The note
// itself lives in the input file, same pointer discipline as every other bounce.
function respawnSection(respawnNotes: string | undefined, inputPath: string): string {
  return respawnNotes
    ? `\n## Your predecessor on this lane died without reporting\n\nRead what it left behind from \`respawnNotes\` in ${inputPath}. Its changes are still in this worktree, UNCOMMITTED and UNVERIFIED -- no stage ever confirmed them, and no transcript of that attempt reaches you. Look before you act (\`git status\`, \`git diff\`, \`git log\`), then decide for yourself whether to keep, fix, or drop them. That call is yours; so is this stage's outcome either way.\n`
    : "";
}

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
  commitNotes?: string; // #177: present on a builder->builder re-spawn (BUILT shipped nothing)
  respawnNotes?: string; // #209: present on a re-spawn of a worker that died with no exit marker
  investigateFirst?: boolean; // second QA bounce: root-cause before touching code
}

// Derived from docs/user-guide/spec/WORKER SAMPLE.md (unattended discipline, exit
// contract, anti-loophole) and PRINCIPLES.md (ponytail ladder, tests + evals +
// docs in the same diff, latent vs deterministic).
export function builderPrompt(i: BuilderPromptInput, inputPath: string, verdict: VerdictTarget, tag?: string): string {
  assertTicketMatch(verdict, i.ticketNumber);
  const bounce = i.qaNotes
    ? `\n## QA findings from the previous pass\n\n${i.investigateFirst ? "Bugs survived a rebuild once already. Run the /investigate skill on these findings FIRST and root-cause them before changing any code -- a symptom patch here earns a third strike and blocks the ticket.\n\n" : ""}Read the findings you must address from \`qaNotes\` in ${inputPath}.\n`
    : "";
  const review = i.reviewNotes
    ? `\n## Reviewer findings to address\n\nRead them from \`reviewNotes\` in ${inputPath}.\n`
    : "";
  // #177: this lane's previous builder reported BUILT with nothing on the branch.
  // Stated up front, before the ticket body, because the work may already be done
  // and sitting uncommitted in the worktree -- rebuilding it from scratch would be
  // the wrong move.
  const commit = i.commitNotes
    ? `\n## Your predecessor on this lane shipped nothing\n\nRead what the pre-advance guard found from \`commitNotes\` in ${inputPath}. Start by inspecting the worktree (\`git status\`, \`git log ${i.baseBranch}..HEAD\`): finish and COMMIT whatever is already there rather than rebuilding it, and only build from scratch if the worktree is genuinely empty. A BUILT is not accepted until the tree is clean and the branch carries at least one commit.\n`
    : "";
  const respawn = respawnSection(i.respawnNotes, inputPath);
  return `${spawnStamp(tag)}You are the BUILDER for ticket #${i.ticketNumber}: "${i.ticketTitle}", running UNATTENDED inside the zstack dev loop. No user is available -- never ask a question, never wait for input; decide or exit via the contract below.

## Workspace
- Worktree: ${i.worktreePath} -- work ONLY here. Other lanes run in sibling worktrees; never read or write outside your own.
- Branch: ${i.branch} (based on ${i.baseBranch}). Commit your work here. Never push, never merge, never touch ${i.baseBranch} or any other branch.

## Ticket
Read your full ticket body (Context, Plan, Acceptance Criteria, Tests + evals, Docs pages touched, Out of scope) from ${inputPath} -- field \`ticketBody\` -- before doing anything else. That body is the contract for this build.
${bounce}${review}${commit}${respawn}
## Discipline
- Ponytail ladder before writing any code: does it need to exist at all; does this codebase already have it; does the stdlib/platform/an installed dep cover it; can it be one line -- only then write the minimum that works. Smallest correct diff, full scope.
- If the ticket has a \`## Files\` section, it is the map -- start from those paths instead of searching.
- The plan's "### Acceptance Criteria" cases are the contract: make each pass AS WRITTEN. Weakening, deleting, or skipping one is a spec question -- exit NEEDS-INPUT, never silently edit a case.
- Ship the whole thing in this one diff: implementation + gate tests + evals (where the work is latent) + every docs page the ticket names.
- Deterministic work (arithmetic, parsing, transforms, lookups) goes in scripts with tests, never in your prose.
- Fix root causes, not symptoms: grep every caller of anything you change.
- Do not edit the issue body, comment on issues, close issues, or expand scope beyond the ticket.

${foregroundRule("builder")}

${verdictInstructions("builder", verdict.path, spawnFor(verdict, "builder"))}

Result meanings for this stage: "BUILT" = all acceptance criteria pass, tests green in the worktree, work committed on ${i.branch} -- VERIFIED before the lane advances: \`git status --porcelain\` empty AND HEAD off ${i.baseBranch}; a BUILT with work still uncommitted sends this lane straight back to you. "NEEDS-INPUT" = a human decision is required; stop immediately, commit nothing half-wired. "BLOCKED" = cannot proceed (broken dependency, failing environment) after a real attempt. "CONFUSED" = the ticket cannot be understood as written.`;
}

// -- QA -----------------------------------------------------------------------

export interface QaPromptInput {
  ticketNumber: number;
  ticketBody: string;
  worktreePath: string;
  branch: string;
  qaPass: number; // 1-based; pass 3 finding bugs blocks the ticket
  webTarget: boolean; // drive gstack /qa against a running site
  respawnNotes?: string; // #209: present on a re-spawn of a QA worker that died with no exit marker
}

// PROCESS.md steps 11-16: functional + technical, as a fresh context that
// distrusts the builder's own claims.
export function qaPrompt(i: QaPromptInput, inputPath: string, verdict: VerdictTarget, tag?: string): string {
  assertTicketMatch(verdict, i.ticketNumber);
  const web = i.webTarget
    ? "\n- This ticket has a web-facing target: use the gstack /qa skill -- spin the site up and drive it as a real user. UI claims without a driven browser check do not count as verified."
    : "";
  return `${spawnStamp(tag)}You are the QA stage for ticket #${i.ticketNumber} (QA pass ${i.qaPass}), running UNATTENDED in a fresh context inside the zstack dev loop. You did not build this; trust nothing you cannot execute yourself. No user is available -- use your judgment or exit via the contract below.

## Workspace
- Worktree: ${i.worktreePath}, branch ${i.branch}. Execute here freely. Do NOT fix anything -- report; the rebuild is the builder's job in a fresh spawn.

## Ticket
Read the ticket body -- Context, Plan, and especially every "### Acceptance Criteria" case -- from ${inputPath}, field \`ticketBody\`, before you start.
${respawnSection(i.respawnNotes, inputPath)}
## Check BOTH, in this order
1. Functional: exercise the built behavior end to end as a user would. Verify every "### Acceptance Criteria" case (setup -> action -> expected outcome) AS WRITTEN -- a case the diff quietly weakened counts as a bug.${web}
2. Technical: typecheck, the full test suite, and the build all green in this worktree; tests + evals + docs the ticket demanded actually present in the diff; the repo's programming principles respected.

${foregroundRule("qa")}

${verdictInstructions("qa", verdict.path, spawnFor(verdict, "qa"))}

Result meanings for this stage: "QA-PASS" = everything above verified green (put the one-line evidence summary in notes, and the suite's real exit code and counts in evidence). "QA-BUGS" = numbered findings in notes, each with concrete repro steps (do X, expect Y, got Z). "NEEDS-HUMAN" = a human must decide; state the question precisely. "BLOCKED" = the worktree cannot be exercised at all. "CONFUSED" = the ticket makes no sense as written. A pass you did not verify is the one unforgivable verdict: the merge gate re-runs the suite itself and a red run there is evidence against every claim in your file.`;
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
// One skeptic's complete brief (#265): composed HERE, deterministically, so
// blindness and the verdict path are enforceable rather than whatever prose
// the reviewer improvises. The reviewer is told to pass each brief VERBATIM as
// an Agent spawn's prompt; the only thing it may not do is edit them. Each
// brief carries its own verdict-file contract, so a skeptic's report is a file
// the ORCHESTRATOR counts (#266) -- the reviewer summarizing "3/3 agreed" has
// no effect on the quorum the merge gate reads.
export function skepticBrief(k: number, input: ReviewerPromptInput, inputPath: string, dir: string, spawn: ExpectedSpawn): string {
  return `You are SKEPTIC ${k} of 3, a fresh context inside the zstack dev loop, blinded exactly as your reviewer is: your ONLY inputs are the ticket body, the acceptance criteria, and the diff, read from ${inputPath} (fields \`ticketBody\`, \`acceptanceCriteria\`, \`diff\`), plus the throwaway worktree at ${input.worktreePath} (yours to execute; nothing you do in it lands anywhere). No other skeptic's verdict reaches you and yours reaches no one but the loop.

Your task is to REFUTE that the diff satisfies the acceptance criteria: find the one criterion it violates, the edge it breaks, a test that passes without the change. Concrete evidence only -- file:line, a command you ran, an input that misbehaves.

${verdictInstructions("skeptic", verdictPath(dir), spawn)}

Result meanings: "REFUTED" = you found concrete evidence the diff fails a criterion -- name it in notes with file:line and the failing input. "UPHELD" = you genuinely tried and could not refute it; notes says what you attacked. "CONFUSED" = the inputs are unusable. Put your lens ("refutation") and the one claim you checked hardest in evidence.`;
}

export function reviewerPrompt(input: ReviewerPromptInput, inputPath: string, verdict: VerdictTarget, adversarial: boolean = false, tag?: string): string {
  assertReviewerInput(input);
  // ponytail: N=3 skeptics is a fixed ceiling (no config knob this ticket); a
  // per-project skeptic count is a follow-on if 3 proves too few/many.
  //
  // #191: three failure modes were measured in loop run 10, all from the same
  // gap -- the block described the happy path (three verdicts arrive) and said
  // nothing about what to do when fewer do. Reviewers hung waiting on a skeptic
  // that never reported, ended a turn with no marker at all (parsed as CONFUSED,
  // which SKIPS the ticket), or reported confidence=100 with no verdicts in hand,
  // which the #62 gate then read as three independent agreements and merged on.
  // Delivery is best-effort by nature (a sub-agent can die or time out), so the
  // fix is to make the DENOMINATOR mandatory and machine-readable rather than to
  // pretend delivery is reliable: `skeptics=<k>/3` is what lib/loop.ts's quorum
  // gate reads. The k-to-confidence mapping is given as a lookup table, never a
  // formula -- arithmetic in a model reply is exactly what PRINCIPLES.md forbids,
  // and for k <= 3 the whole space is nine entries.
  //
  // #318: #191's block above was still not enough, and loop 17 showed why. It told
  // the reviewer to "check for outstanding verdicts AT MOST ONCE per skeptic, then
  // stop waiting" -- which presumes verdicts arrive on some channel the reviewer can
  // poll. They do not. The Agent tool spawns in the BACKGROUND by default, and a
  // background sub-agent's only delivery channel is a task notification BETWEEN
  // turns; a stage agent is sent exactly one message by design (PROCESS.md), so the
  // between-turns channel does not exist for it. "Check once" is therefore an
  // instruction whose only available implementation is "end the turn and see what
  // arrives" -- and ending the turn is what loses the ticket. Loop 17 lost 2 of 3
  // tickets to exactly that reading, on green committed diffs: the #192 reviewer
  // closed on "Waiting for skeptic completion notifications." and #207's second
  // attempt on "I've pinged all three once per stage instructions. Let me wait
  // briefly for responses." Both were parsed as CONFUSED and skipped; every skeptic
  // then reported minutes later into a lane already closed, two of them carrying
  // real reproducible defects.
  //
  // So the fix is mechanical, not exhortative: name the flag that makes collection
  // happen INSIDE the turn (`run_in_background: false`, three calls in one message
  // so they still run concurrently), and make the verdicts arrive as tool results
  // the reviewer simply reads. With that, there is nothing outstanding to poll and
  // "wait" stops being a coherent action rather than a discouraged one. The degraded
  // path is then named explicitly, because a reviewer holding k < 3 needs a
  // sanctioned exit or it invents the silent one again.
  const skepticDirs = verdict.skepticDirs ?? [];
  if (adversarial && skepticDirs.length !== 3) {
    throw new ZError(
      `An adversarial reviewer prompt needs exactly 3 skeptic artifact directories (verdict.skepticDirs), got ${skepticDirs.length}. The orchestrator composes them off \`transcripts dest\`; the reviewer never invents paths.`
    );
  }
  const briefs = adversarial
    ? skepticDirs
        .map((dir, idx) => {
          const k = idx + 1;
          return `### Skeptic ${k}'s brief -- pass VERBATIM as one Agent spawn's prompt (edit nothing)\n\n<<<SKEPTIC-${k}-BRIEF\n${skepticBrief(k, input, inputPath, dir, spawnFor(verdict, "skeptic"))}\nSKEPTIC-${k}-BRIEF`;
        })
        .join("\n\n")
    : "";
  const superTruth = adversarial
    ? `
## Super-truth pass (adversarial mode active)
This card's blast radius earned an adversarial review; do NOT trust your single read. Spawn 3 INDEPENDENT skeptic sub-agents with the Agent tool -- nested \`claude -p\` is denied by the classifier, so use the Agent tool, not headless claude. Their briefs are WRITTEN FOR YOU below, one per skeptic, each already carrying the blinded inputs pointer and its own verdict-file contract. Pass each brief verbatim as that spawn's prompt; the composition is not yours to edit -- a reworded brief is how blindness leaks and how verdict files end up where nothing counts them.

COLLECT THEM INSIDE THIS TURN. Spawn all three in ONE message, as three Agent tool calls each carrying \`run_in_background: false\`. That flag is the entire mechanism: it makes the three returns come back as tool results in this same turn, and the three still run concurrently because they were launched together. The DEFAULT is a background spawn, whose only delivery channel is a task notification BETWEEN turns -- and you get no next turn, because this loop sends a stage agent exactly one message by design. A backgrounded skeptic is one you will never hear from, however long you wait.

You therefore never wait for a skeptic, and you never re-count for one either: each skeptic reports by WRITING ITS OWN VERDICT FILE, and the loop counts those files itself -- a skeptic that lands after you return still counts, and a tally you write cannot vouch for a file that is not there. Once your three tool calls return, read whichever skeptic verdict files exist, weigh any refutation's evidence in your own judgment, and write YOUR verdict. Do not spawn replacements, do not re-ping, and do not end your turn to "wait", "check back", or "await completion notifications" -- three reviews in one run ended a turn on exactly those words, all three thrown away with green, committed work.

In your verdict file's evidence, set "skepticVerdictPaths" to the paths of ONLY the skeptic verdict files that exist when you look (0-3 of them; list none that you cannot read). Set "confidence" off this table over the k verdicts you actually hold -- do no arithmetic:
- k=3: 3 UPHELD -> 100, 2 -> 67, 1 -> 33, 0 -> 0
- k=2: 2 UPHELD -> 100, 1 -> 50, 0 -> 0
- k=1: 1 UPHELD -> 100, 0 -> 0
- k=0: nobody looked. Your OWN single-pass certainty that every criterion holds -- never 100, which would claim three independent agreements that never happened.
A criterion any skeptic REFUTED with concrete evidence is a finding, not a vote to be outnumbered -- surface it in your notes. An honest short list costs this card one more review pass; a padded one merges a diff nobody refuted.

${briefs}
`
    : "";
  return `${spawnStamp(tag)}You are an ADVERSARIAL REVIEWER in a fresh context, running UNATTENDED inside the zstack dev loop. You are blinded by design: your ONLY inputs are the ticket, its acceptance criteria, the diff, and a throwaway worktree of the head commit. There is no PR description, no plan rationale, no builder or QA transcript -- and any claim you cannot verify from these inputs yourself is unverified. Your job is to find the reasons this diff should NOT merge.

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
${foregroundRule("reviewer")}

${verdictInstructions("reviewer", verdict.path, spawnFor(verdict, "reviewer"))}

Result meanings for this stage: "REVIEW-APPROVE" = every criterion verified against the diff, typecheck + touched tests green; evidence.confidence is your certainty every criterion holds, 0-100 (${adversarial ? "read it off the super-truth table above" : "self-assessed on this single pass"}), and a score below the project's configured floor will NOT merge -- an approve with no usable confidence is refused by the gate, never waved through. "REVIEW-FINDINGS" = numbered findings in notes, each with file:line and why it blocks the merge. "NEEDS-HUMAN" = a genuine spec ambiguity a human must settle. "BLOCKED" = the throwaway worktree is unusable -- can't check out or execute the diff at all. "CONFUSED" = the inputs make no sense${adversarial ? `, including a skeptic fan-out so broken you cannot judge the diff at all (name what happened in notes)` : ""}.`;
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

// The loop-owned merge gate's CLI, by absolute path off THIS pack (#178). The
// merge agent is told to shell it, never to read test output and judge green
// itself -- the whole point of the gate is that no latent step decides it.
// The prompt must never ASSERT that the gate already ran green: the loop does
// gate this lane before the spawn (nextAction refuses to advance to merge
// without a stamped green verdict), but a prompt that states it as fact would
// be an unverifiable claim inside the agent's own context, and a claim is
// exactly what this ticket replaces with a command. So the gate is Step 1 --
// unconditional, ahead of every numbered step, and the agent's own exit code is
// its permission to merge. (Step 0 is the version claim, which lands a commit on
// the branch and so must precede the run that vouches for the merged commit.)
const MERGE_GATE_CLI = join(import.meta.dir, "loop.ts");

// The version-claim CLI, same absolute-path-off-THIS-pack rule as the gate
// above and for the same reason: the merge agent runs from a lane worktree,
// which is not this pack.
const VERSION_CLI = join(import.meta.dir, "version.ts");

export interface MergePromptInput {
  ticketNumber: number;
  prTitle: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  stackedOn: number[]; // parent tickets in this batch (PROCESS.md step 18)
  // The loop's state.json (#178). Present -> Step 1 renders the STAMPING form of
  // the gate, so the verdict for the commit the agent is ACTUALLY merging --
  // including the re-run after a conflict resolution, which the loop cannot
  // interleave a tick into -- lands on the lane, naming that commit's sha,
  // where the reducer and the run report can see it. Absent -> the read-only
  // form: the exit code still gates the merge, only the audit trail is lost.
  statePath?: string;
}

export function mergePrompt(i: MergePromptInput, inputPath: string, verdict: VerdictTarget, tag?: string): string {
  assertTicketMatch(verdict, i.ticketNumber);
  const stacked = i.stackedOn.length
    ? `\n## Stacked chain (PROCESS.md step 18 -- order is not optional)
This branch stacks on ticket(s) #${i.stackedOn.join(", #")}. Their PRs merge FIRST, each WITHOUT deleting its branch (deleting a base branch closes every dependent PR). After each parent lands, retarget this PR to ${i.baseBranch} (gh pr edit --base ${i.baseBranch}). Delete branches only after the whole batch has landed.

A parent landing MOVES ${i.baseBranch}'s VERSION, so after the last retarget re-run Step 0's claim command and then Step 1's gate, exactly as the conflict path does. Without it this branch merges carrying a slot it claimed before its parent existed on ${i.baseBranch}, which is a version going backwards.\n`
    : "";
  // ABSOLUTE worktree path, always. The Workspace line names the worktree and
  // step 2 tells the agent to resolve conflicts ON the branch, so it may well
  // `cd` in there -- and a relative `.worktrees/ticket-<N>` argument then
  // resolves against the WRONG root, the gate throws "worktree does not exist",
  // and Step 1's own "ANY nonzero exit = BLOCKED" rule false-blocks a branch
  // that was ready to land. resolve() runs in the orchestrator's cwd (the repo
  // root), which is where the relative form was always meant to be read.
  const worktree = resolve(i.worktreePath);
  const gateStamp = i.statePath ? ` --state ${shSingleQuote(resolve(i.statePath))} --ticket ${i.ticketNumber}` : "";
  // Both scratch files sit beside the stage input, never inside the worktree:
  // an untracked file in the tree the gate is about to measure is noise at best,
  // and `git add`-ed by a careless step at worst.
  const entryPath = join(dirname(inputPath), `changelog-${i.ticketNumber}.md`);
  const titlePath = join(dirname(inputPath), `pr-title-${i.ticketNumber}.txt`);
  return `${spawnStamp(tag)}You are the MERGE stage for ticket #${i.ticketNumber}, running UNATTENDED inside the zstack dev loop. QA and adversarial review have both passed; your job is to land the branch cleanly.

## Workspace
- Worktree: ${worktree}, branch ${i.branch}, base ${i.baseBranch}.
- Full stage input (numbers, PR title, branch, base, worktree, stacked chain) is in ${inputPath} if you need to re-read any field.
${stacked}
## Step 0 -- claim this PR's version slot. The NUMBER is not yours to pick
Every PR carries its own version bump, committed before the PR exists. Write a 1-3 sentence CHANGELOG entry for what this ticket shipped to ${entryPath} -- that prose is the ONLY part of this step that is yours -- then run:

bun ${shSingleQuote(VERSION_CLI)} claim --ticket ${i.ticketNumber} --worktree ${shSingleQuote(worktree)} --base ${shSingleQuote(i.baseBranch)} --title ${shSingleQuote(i.prTitle)} --entry-file ${shSingleQuote(entryPath)} --title-out ${shSingleQuote(titlePath)}

It reads origin/${i.baseBranch}'s VERSION and every other open PR's claim, derives the bump level from this ticket's labels, writes VERSION + package.json + CHANGELOG.md, commits and pushes. Re-running it when nothing moved is a no-op.

Never edit VERSION, package.json or a CHANGELOG heading yourself, and never type a version number anywhere: a hand-picked slot is how two PRs end up claiming one version and how a release goes backwards. Nonzero exit = stop and exit BLOCKED with its message; do NOT open the PR. It runs BEFORE the gate because it commits to the branch, and the gate must vouch for the commit that actually merges.

## Step 1 -- run the green gate. It is NOT yours to judge (#178)
Run this yourself, in THIS session, before any gh pr merge -- unconditionally, whatever you were told about earlier runs:

bun ${shSingleQuote(MERGE_GATE_CLI)} merge-gate ${shSingleQuote(worktree)}${gateStamp}

Every path in it is absolute, so it runs correctly from any directory -- including from inside the worktree. Copy it verbatim; do not substitute a relative path.

Exit 0 = green, the only state in which gh pr merge may run. ANY nonzero exit = stop and exit BLOCKED with the gate's note, no matter what the output looks like to you. You never decide green vs red by reading test output: a merge agent that did exactly that landed a branch with 9 failing tests and broke ${i.baseBranch}.

Give the command the largest timeout your shell tool allows (600000 ms), never a 120s default: it runs the worktree's test script plus its typecheck, and any red first attempt is retried once, adding a 15s wait and a second full run. The gate bounds itself to 570s of wall clock, so it answers inside that window; a killed command is not a verdict, re-run it.

Run it AGAIN -- the same command, byte for byte -- after any change you make to the branch (a conflict resolution). The run before your change does not vouch for the code after it, and the verdict records the commit sha it tested, so the re-run is what puts your merged commit on the record.

## Steps
1. Open the PR: gh pr create --base ${i.baseBranch} --head ${i.branch} --title "$(cat ${shSingleQuote(titlePath)})" with a body that links the ticket and summarizes what shipped. Step 0 wrote that file, and the title in it carries the claimed version -- do not retype it.
2. If ${i.branch} conflicts with ${i.baseBranch}: resolve ON the branch, then re-run Step 0's claim command AND Step 1's gate command exactly as written, in that order, before merging (never in prose, never resolve in the merge commit blind). Resolving pulled ${i.baseBranch} in, so the base VERSION just moved; a CHANGELOG conflict resolves by KEEPING BOTH sections, newest version on top. Either command nonzero -> exit BLOCKED with its note.
3. Merge with gh pr merge only when the gate exited 0. Never pass --delete-branch: branch cleanup happens once at batch end, after every dependent PR has landed.
4. Do not close the ticket issue and do not comment on it -- the orchestrator posts the completion note.

${verdictInstructions("merge", verdict.path, spawnFor(verdict, "merge"))}

Result meanings for this stage: "MERGED" = gh pr merge succeeded on a green gate; evidence.prUrl is the PR's URL and evidence.mergeSha the merged commit. "NEEDS-HUMAN" = a judgment call only a human can make. "BLOCKED" = what failed and what you tried (a nonzero gate or claim exit lands here, with its message). "CONFUSED" = the inputs make no sense.`;
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

// -- plan-time edges -----------------------------------------------------------

// PROCESS.md step 6/step 3, C6's plan-time counterpart to completionNote above:
// the same "edges a human must validate" class (chosen defaults, spec-ambiguous
// calls, data-loss-ish behaviors) but surfaced when the PLAN is authored, not
// when the work completes. Reuses CompletionEdge -- same {check, doStep, expect}
// shape, same to-check-X-do-Y-expect-Z rendering. Informational only: an empty
// list renders "" so the caller posts no comment; this never blocks a ticket --
// a blocking question is the separate `## Needs input --` + Questions move
// (z-plan/SKILL.md Step 8, PROCESS.md step 6), not this comment.
export function planEdgesComment(edges: CompletionEdge[]): string {
  if (edges.length === 0) return "";
  const bullets = edges.map((e) => `- To check ${e.check}, do ${e.doStep}, expect ${e.expect}.`).join("\n");
  return `## Needs input — edges a human should validate\n\n${bullets}`;
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `stage-prompts <command> [args]

  prompt <builder|qa|merge> <input.json> --verdict-path <file> --run <runId> --ticket <n> --attempt <k>
                                                    print the stage prompt built from the typed input.
                                                    The --verdict-* flags name the verdict FILE the stage
                                                    must write and the spawn its envelope must carry
                                                    (#323, \`verdict path\` composes the file path)
  prompt reviewer <input.json> --verdict-path <f> --run <id> --ticket <n> --attempt <k>
                 [--adversarial-mode <off|non-trivial|always>] [--labels <json-array>]
                 [--skeptic-dirs <json-array-of-3-dirs>]
                                                    print the reviewer prompt; the flags decide the
                                                    super-truth fan-out deterministically (diff size + labels + mode).
                                                    Adversarial requires --skeptic-dirs: the briefs name each
                                                    skeptic's verdict file, composed by the orchestrator (#265)
  ... [--spawn-tag <tag>]                           any stage: stamp an inert first line naming this spawn, so
                                                    \`transcripts collect\` can find the agent's own transcript
                                                    (\`transcripts tag\` prints the value). Omitted -> no stamp.
  stub <builder|qa|reviewer|merge> <prompt.txt> [--spawn-tag <tag>]
                                                    print the SPAWN STUB for a prompt already written by
                                                    \`prompt\`: a ~450-byte pointer telling the worker to read
                                                    that file. Pass THIS as the Agent spawn's prompt param, not
                                                    the prompt itself -- the stub's size is independent of the
                                                    prompt's, which keeps the orchestrator's context flat across
                                                    a drain. Errors if the prompt file is unreadable.
  note <input.json>                                 print the completion note (CompletionNoteInput)
  plan-edges <edges.json>                           print the plan-time "Needs input" edges comment
                                                    (CompletionEdge[]); prints nothing for an empty list`;

// The four --verdict-* flags every `prompt` invocation carries since #323: the
// file the stage must write and the spawn coordinates its envelope must name.
// One reader so the five flags cannot be half-parsed at two call sites.
function verdictTargetFromFlags(flags: Record<string, string | boolean>): VerdictTarget {
  const path = str(flags, "verdict-path");
  const runId = str(flags, "run");
  const ticketRaw = str(flags, "ticket");
  const attemptRaw = str(flags, "attempt");
  if (path === undefined || runId === undefined || ticketRaw === undefined || attemptRaw === undefined) {
    throw new ZError(
      `prompt requires --verdict-path <file> --run <runId> --ticket <n> --attempt <k> (#323): the stage's exit contract IS the verdict file, so a prompt without its target cannot be obeyed.`
    );
  }
  const ticket = Number(ticketRaw);
  const attempt = Number(attemptRaw);
  if (!Number.isInteger(ticket) || ticket <= 0) throw new ZError(`--ticket must be a positive integer, got ${JSON.stringify(ticketRaw)}.`);
  if (!Number.isInteger(attempt) || attempt <= 0) throw new ZError(`--attempt must be a positive integer, got ${JSON.stringify(attemptRaw)}.`);
  return { path, runId, ticket, attempt };
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    // Shared CLI plumbing (lib/cli.ts): the reviewer's two optional flags
    // (--adversarial-mode, --labels) split out here, positionals keep their
    // order. Moved inside the try (issue #156): parseFlags can now throw a
    // loud ZError on a trailing value-flag, and that needs the same
    // handleCliError epilogue every other usage error in this function gets,
    // not an uncaught throw out of main().
    const { positionals, flags } = parseFlags(argv.slice(1));
    if (cmd === "prompt") {
      const stage = positionals[0];
      const path = positionals[1];
      // #190: absent -> spawnStamp renders "" and the prompt is byte-identical
      // to pre-#190, so an operator building a prompt by hand loses nothing.
      const spawnTagFlag = str(flags, "spawn-tag");
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
        const modeArg = str(flags, "adversarial-mode");
        const mode = (modeArg ?? DEFAULT_ADVERSARIAL_MODE) as AdversarialMode;
        if (!ADVERSARIAL_MODES.includes(mode)) {
          throw new ZError(
            `--adversarial-mode must be one of "off", "non-trivial", "always", got ${JSON.stringify(modeArg)}.`
          );
        }
        let labels: string[] = [];
        const labelsArg = str(flags, "labels");
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
        // #323: an adversarial reviewer additionally needs its three skeptic
        // artifact directories, orchestrator-composed (`transcripts dest` +
        // /skeptic-<k>) so the briefs' verdict paths are enforceable (#265).
        let skepticDirs: string[] | undefined;
        const dirsArg = str(flags, "skeptic-dirs");
        if (dirsArg !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(dirsArg);
          } catch (e) {
            throw new ZError(`--skeptic-dirs must be a JSON array of 3 directory paths: ${(e as Error).message}`);
          }
          if (!Array.isArray(parsed) || parsed.some((d) => typeof d !== "string")) {
            throw new ZError(`--skeptic-dirs must be a JSON array of directory paths.`);
          }
          skepticDirs = parsed as string[];
        }
        // Pointer prompt (ticket #57): reviewer reads its payload from the input
        // file by ABSOLUTE path; the flag-derived `active` selects the fan-out.
        // --spawn-tag (#190) is a POSITIONAL scalar, same as mode/labels: it
        // never enters the blinded four-key input JSON, and neither does the
        // verdict target (a constructor parameter).
        console.log(reviewerPrompt(input, resolve(path), { ...verdictTargetFromFlags(flags), skepticDirs }, active, spawnTagFlag));
        return 0;
      }
      const builders: Record<string, (i: any, inputPath: string, verdict: VerdictTarget, tag?: string) => string> = {
        builder: builderPrompt,
        qa: qaPrompt,
        merge: mergePrompt,
      };
      const build = builders[stage];
      if (!build) throw new ZError(`Unknown stage "${stage}". Valid: builder, qa, reviewer, merge.`);
      // The pointer prompt references this input file by ABSOLUTE path, so the
      // worker (a fresh Agent with its own CWD) resolves it unambiguously.
      console.log(build(input, resolve(path), verdictTargetFromFlags(flags), spawnTagFlag));
      return 0;
    }
    if (cmd === "stub") {
      const stage = positionals[0] as Stage;
      const promptPath = positionals[1];
      if (!stage || !promptPath) throw new ZError("Usage: stage-prompts stub <builder|qa|reviewer|merge> <prompt.txt> [--spawn-tag <tag>]");
      if (!STAGES.includes(stage)) throw new ZError(`Unknown stage "${stage}". Valid: ${STAGES.join(", ")}.`);
      // Fail HERE, not in the worker. The stub's whole contract is "your
      // instructions are at this path"; emitting one that points at nothing
      // would trade an immediate, free CLI error for a burned agent spawn that
      // can only report BLOCKED. statSync-by-read is enough -- the file is
      // written by `prompt` moments earlier in the same step.
      try {
        readFileSync(promptPath, "utf8");
      } catch (e) {
        throw new ZError(`Cannot read stage prompt at ${promptPath}: ${(e as Error).message}`);
      }
      // ABSOLUTE, for the same reason the pointer prompt resolves inputPath: the
      // worker is a fresh Agent with its own CWD.
      console.log(spawnStub(stage, resolve(promptPath), str(flags, "spawn-tag")));
      return 0;
    }
    if (cmd === "note") {
      if (!positionals[0]) throw new ZError("Usage: stage-prompts note <input.json>");
      const input = JSON.parse(readFileSync(positionals[0], "utf8")) as CompletionNoteInput;
      console.log(completionNote(input));
      return 0;
    }
    if (cmd === "plan-edges") {
      if (!positionals[0]) throw new ZError("Usage: stage-prompts plan-edges <edges.json>");
      const edges = JSON.parse(readFileSync(positionals[0], "utf8")) as CompletionEdge[];
      const out = planEdgesComment(edges);
      // Empty list -> no output, so a caller's "post only if non-empty" check
      // ($(...) truthiness on the captured string) sees nothing to post.
      if (out) console.log(out);
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
