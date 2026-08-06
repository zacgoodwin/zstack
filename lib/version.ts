// Per-PR version claiming. Every branch the loop merges carries its OWN VERSION
// bump, committed on the branch before its PR is opened, instead of a human
// rolling one release-only PR after the fact.
//
// Why this exists at all: gstack's /review reads a PR's claimed version off the
// BRANCH (`git show HEAD:VERSION`) and compares it against the next free slot in
// the open-PR queue. With no bump on the branch, every PR read as claiming the
// base version and that check was vacuous -- it could not distinguish "this PR
// claims a free slot" from "this PR claims nothing". It also removes the stale
// release-only PR, which is not a hypothetical failure: one resolved
// DESTRUCTIVELY against a moved base and had to be killed by hand (#143).
//
// PRINCIPLES.md line: the slot, the bump level, the heading and the date are all
// computed HERE. The only latent input is the CHANGELOG prose, which arrives via
// --entry-file because summarizing what shipped is genuinely a judgment call.
// A merge agent never picks a version number, and never edits VERSION,
// package.json, or a CHANGELOG heading by hand.
//
// LOAD-BEARING INVARIANT, enforced in another file: this reads the queue, picks a
// slot, and pushes -- three steps with no atomic reservation between them. That
// is sound ONLY because the loop runs one merge stage at a time (`midMerge` in
// lib/loop.ts's nextAction: "Merge gate: one merge at a time"), so no second
// claimer exists during the window. A claim also happens BEFORE its PR exists,
// so a concurrent claimer would be invisible to openPrVersions and both would
// pick the same slot. If merge is ever parallelised, this needs a real
// reservation -- a claim commit pushed to a ref and re-read, or a lock -- and
// not a wider read. Running this CLI by hand while a drain is live has the same
// exposure.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Board, ghExecutor } from "./board.ts";
import { BoardConfig, ZError, loadConfig } from "./config.ts";
import { isLaneBranch } from "./loop.ts";
import { atomicWrite, handleCliError, parseFlags, requireFlag, str } from "./cli.ts";

// -- the version itself -------------------------------------------------------

// MAJOR.MINOR.PATCH.MICRO, the four-segment shape gstack's queue reader and
// /ship both speak. Not semver's three: the fourth segment is what makes a
// per-PR claim cheap, since routine work moves only it.
export type Bump = "major" | "minor" | "patch" | "micro";
export type Version = [number, number, number, number];

// Ordered least- to most-significant so a "highest label wins" reduction is a
// max over indices rather than a comparison table.
//
// The `Record<Bump, number>` intermediate is what makes this exhaustive at
// COMPILE time. `bumpVersion`'s switch and `SECTION_FOR_BUMP` already break the
// build when a level is added; a bare `Bump[]` literal would not -- it would
// compile with the new level missing, `indexOf` would return -1, and the
// comparison below would silently rank the new level BELOW micro. Adding a level
// now fails to typecheck here until it is ranked.
const BUMP_RANK: Record<Bump, number> = { micro: 0, patch: 1, minor: 2, major: 3 };

export const BUMP_ORDER: Bump[] = (Object.keys(BUMP_RANK) as Bump[]).sort((a, b) => BUMP_RANK[a] - BUMP_RANK[b]);

// Segments are capped at 9 digits. Without a cap, `Number` silently rounds past
// 2^53 -- two different 20-digit segments compare EQUAL, and a bumped one can
// round back to itself, so the "strictly greater" property the whole queue rests
// on stops holding. The claims this parses come from other PRs' branches, so the
// input is not fully trusted; 9 digits is past any real version and short enough
// to stay exact.
export function parseVersion(s: string): Version | null {
  const m = s.trim().match(/^(\d{1,9})\.(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

export function fmtVersion(v: Version): string {
  return v.join(".");
}

export function bumpVersion(v: Version, level: Bump): Version {
  switch (level) {
    case "major":
      return [v[0] + 1, 0, 0, 0];
    case "minor":
      return [v[0], v[1] + 1, 0, 0];
    case "patch":
      return [v[0], v[1], v[2] + 1, 0];
    case "micro":
      return [v[0], v[1], v[2], v[3] + 1];
  }
}

// Lexicographic over the four segments. Negative when a < b, as Array#sort wants.
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// -- label -> bump level ------------------------------------------------------

// The shipped mapping, keyed on GitHub's own default label set plus the two
// conventional names a project usually adds. Lowercased keys; the lookup
// lowercases too, so `Bug` and `bug` are the same label.
//
// Anything unmapped -- an unlabeled ticket, `documentation`, `question`, a
// project's own taxonomy -- falls to MICRO. That direction is deliberate: an
// unrecognized label must never quietly inflate a release, and MICRO is the
// segment whose movement claims nothing about the change.
export const DEFAULT_BUMP_LABELS: Record<string, Bump> = {
  breaking: "major",
  "breaking-change": "major",
  enhancement: "minor",
  feature: "minor",
  bug: "patch",
  fix: "patch",
};

export const FALLBACK_BUMP: Bump = "micro";

// The HIGHEST level any of the ticket's labels maps to, so the result does not
// depend on the order GitHub happened to return them in. A ticket labeled both
// `bug` and `enhancement` is an enhancement that fixes something, not a patch.
export function bumpLevelFor(
  labels: string[],
  map: Record<string, Bump> = DEFAULT_BUMP_LABELS
): { level: Bump; from?: string } {
  // Both sides are lowercased. GitHub label names are case-PRESERVING but
  // case-insensitive for uniqueness, so a config written `{"Breaking": "major"}`
  // and a label rendered `breaking` are the same label, and a map that only
  // matched exact case would silently demote it to MICRO.
  const lower: Record<string, Bump> = {};
  for (const [k, v] of Object.entries(map)) lower[k.trim().toLowerCase()] = v;
  let level = FALLBACK_BUMP;
  let from: string | undefined;
  for (const raw of labels) {
    const hit = lower[raw.trim().toLowerCase()];
    if (hit && BUMP_RANK[hit] > BUMP_RANK[level]) {
      level = hit;
      from = raw;
    }
  }
  return from === undefined ? { level } : { level, from };
}

// -- slot allocation ----------------------------------------------------------

export interface ClaimedSlot {
  pr: number;
  branch: string;
  version: string;
}

export interface SlotPick {
  version: Version;
  // The version the bump was applied to: the base, or the highest outstanding
  // claim when one already sits above it.
  ceiling: Version;
  // Which open PR set the ceiling, when it was not the base branch.
  ceilingFrom?: ClaimedSlot;
}

// The next free slot: bump the GREATEST of (base, every outstanding claim) by
// `level`.
//
// Bumping the greatest rather than the base is what makes the numbering
// monotonic no matter which PR lands first. Bump the base alone and a `patch`
// ticket picks 1.0.2.0 while an open PR already holds 1.0.1.1; that is free
// today, but when the other PR merges LAST the version on main goes backwards.
// Since the ceiling is by definition >= every claim, the pick is strictly above
// all of them and no collision loop is needed.
//
// Skipping numbers when an outstanding PR is later closed unmerged is the
// accepted cost. A gap in the sequence is cosmetic; a version that decreases is
// a release artifact nobody can order.
export function nextFreeSlot(base: Version, claimed: ClaimedSlot[], level: Bump): SlotPick {
  let ceiling = base;
  let ceilingFrom: ClaimedSlot | undefined;
  for (const c of claimed) {
    const v = parseVersion(c.version);
    // An unparseable claim is skipped rather than read as 0.0.0.0 -- a branch
    // may predate per-PR claiming entirely. Skipping is not free (see
    // Q_OPEN_PR_VERSIONS in lib/board.ts: dropping the highest claim lowers this
    // maximum and can hand its slot to the next claimer), but reading garbage as
    // a real claim is worse, and failing closed would wedge the whole repo
    // behind one legacy PR.
    if (v && compareVersions(v, ceiling) > 0) {
      ceiling = v;
      ceilingFrom = c;
    }
  }
  const pick: SlotPick = { version: bumpVersion(ceiling, level), ceiling };
  if (ceilingFrom) pick.ceilingFrom = ceilingFrom;
  return pick;
}

// -- CHANGELOG ----------------------------------------------------------------

// Keep a Changelog's section for each level. MAJOR and MICRO both land under
// Changed: a breaking change IS a change, and MICRO is the catch-all whose
// content is by definition unclassified.
export const SECTION_FOR_BUMP: Record<Bump, string> = {
  major: "Changed",
  minor: "Added",
  patch: "Fixed",
  micro: "Changed",
};

const HEADING = /^## \[/m;

// The entry is the ONE agent-authored value in this whole path, and it is
// written verbatim into a file that both changelogInsert and changelogReclaim
// later parse by regex. A `## [` line inside the prose is therefore not a typo,
// it is a structural forgery: changelogInsert keys off the FIRST such heading to
// decide where a section begins, and changelogReclaim rewrites the first heading
// matching a version -- so an entry carrying one can move a future claim's
// section boundary or get itself rewritten as though it were a release.
//
// Refuses rather than strips. Silently editing an agent's prose hides the
// problem; a nonzero exit sends it back with the reason, and re-running the
// claim is a no-op, so the cost of being wrong here is one retry. Same
// fail-closed direction as every other refusal in this file.
export const MAX_ENTRY_CHARS = 20_000;

export function assertUsableEntry(entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed) throw new ZError(`The CHANGELOG entry is empty.`);
  if (trimmed.length > MAX_ENTRY_CHARS) {
    throw new ZError(
      `The CHANGELOG entry is ${trimmed.length} characters, over the ${MAX_ENTRY_CHARS} ceiling. ` +
        `Write what shipped, not the whole diff.`
    );
  }
  const forged = trimmed.split(/\r?\n/).find((l) => /^## \[/.test(l));
  if (forged !== undefined) {
    throw new ZError(
      `The CHANGELOG entry contains its own version heading (${JSON.stringify(forged)}). ` +
        `The heading is written by this command, never by the entry -- one inside the prose moves the ` +
        `section boundary a later claim reads. Remove it and re-run; describe the change in prose instead.`
    );
  }
}

export function changelogSection(version: string, date: string, level: Bump, entry: string): string {
  return `## [${version}] - ${date}\n\n### ${SECTION_FOR_BUMP[level]}\n\n${entry.trim()}\n`;
}

// Inserts this claim's section at the top of the version list.
//
// The `[Unreleased]` branch is the one-time transition off the manual release
// PR: when the topmost heading is still Unreleased, its heading is REWRITTEN
// into this claim's version rather than pushed down, so everything accumulated
// under it is rolled into the release that is actually shipping instead of
// waiting for a human to do it later. After that first claim the file has no
// Unreleased section and every subsequent claim takes the plain insert branch.
export function changelogInsert(existing: string, version: string, date: string, level: Bump, entry: string): string {
  const idx = existing.search(HEADING);
  const section = changelogSection(version, date, level, entry);
  // No version list yet (a fresh CHANGELOG, or a repo whose file is all
  // preamble): append rather than guess where a list should start.
  if (idx === -1) return `${existing.replace(/\s*$/, "")}\n\n${section}`;
  const head = existing.slice(0, idx);
  const rest = existing.slice(idx);
  const unreleased = rest.match(/^## \[Unreleased\][^\n]*\n/i);
  // Same section text as the plain branch, built by the same function -- the two
  // differ only in whether the Unreleased heading is consumed or pushed down.
  if (unreleased) return `${head}${section}${rest.slice(unreleased[0].length)}`;
  return `${head}${section}\n${rest}`;
}

// Re-points an existing claim at a new slot: the queue moved under a branch that
// already claimed (a lane blocked at merge and resumed in a later run). Only the
// heading line changes -- the prose written for this ticket is still the prose
// for this ticket.
//
// Throws rather than inserting a second section when the old heading is absent:
// VERSION says this branch claimed `from`, and a CHANGELOG that does not agree
// is an inconsistency a human should look at, not one to paper over by leaving
// the stale heading behind.
export function changelogReclaim(existing: string, from: string, to: string, date: string): string {
  const re = new RegExp(`^## \\[${from.replace(/\./g, "\\.")}\\][^\\n]*$`, "m");
  if (!re.test(existing)) {
    throw new ZError(
      `CHANGELOG.md has no "## [${from}]" heading, but VERSION on this branch says ${from} was already claimed. ` +
        `Reconcile the two by hand before merging -- refusing to add a second section for the same work.`
    );
  }
  return existing.replace(re, `## [${to}] - ${date}`);
}

// -- package.json -------------------------------------------------------------

// A TEXT replacement of the one `"version": "<current>"` pair, not a
// parse/stringify round trip: rewriting the whole file reflows every line the
// project formatted by hand and buries a one-token change in a 40-line diff.
//
// The replacement is then VERIFIED by re-parsing, because "the first textual
// match is the top-level key" is false. A nested object carrying the same
// version string earlier in the file wins the match:
//
//   {"dependency": {"version": "1.0.0.0"}, "version": "1.0.0.0"}
//
// rewrote the DEPENDENCY and left the package's own version stale -- silently,
// since the file stayed valid JSON. Reproduced before this guard existed. The
// re-parse turns that from a silent desync into a refusal, and it also covers
// the duplicate-key and unusual-formatting shapes rather than just this one.
export function setPackageVersion(text: string, next: string): string {
  let pkg: any;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    throw new ZError(`package.json is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof pkg.version !== "string") return text; // no version field to keep in sync
  const re = new RegExp(`("version"\\s*:\\s*)"${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const out = text.replace(re, `$1"${next}"`);
  let check: any;
  try {
    check = JSON.parse(out);
  } catch (e) {
    throw new ZError(`Rewriting package.json's version produced invalid JSON: ${(e as Error).message}`);
  }
  if (check.version !== next) {
    throw new ZError(
      `Could not set package.json's top-level "version" to ${next}: after the edit it reads ` +
        `${JSON.stringify(check.version)}. Some other "version" key matched first (a dependency or a ` +
        `nested object carrying the same string). Fix package.json by hand, then re-run.`
    );
  }
  return out;
}

// -- writing the claim --------------------------------------------------------

export const VERSION_FILE = "VERSION";
export const PACKAGE_FILE = "package.json";
export const CHANGELOG_FILE = "CHANGELOG.md";

export interface ApplyInput {
  worktree: string;
  versionPath: string;
  next: string;
  level: Bump;
  date: string;
  entry: string;
  // Set when this branch had already claimed a (now-stale) slot: the CHANGELOG
  // heading is re-pointed instead of a second section being inserted.
  reclaimFrom?: string;
}

// Writes VERSION, package.json and CHANGELOG.md, returning the repo-relative
// paths it actually touched (the caller stages exactly those). package.json and
// CHANGELOG.md are both OPTIONAL: this pack is installed into other people's
// repos, and a project with neither still gets a valid claim.
// EVERY file's new content is computed BEFORE the first byte is written.
// changelogReclaim throws on an inconsistency it refuses to paper over, and
// writing VERSION first meant that throw left the worktree dirty with a bumped
// VERSION and no commit -- so the gate that runs next measured a tree carrying
// half a claim, and the merge agent's BLOCKED exit stranded it there.
export function applyClaim(i: ApplyInput): string[] {
  const abs = (rel: string) => join(i.worktree, rel);
  const pending: [string, string][] = [[i.versionPath, `${i.next}\n`]];

  if (existsSync(abs(PACKAGE_FILE))) {
    const before = readFileSync(abs(PACKAGE_FILE), "utf8");
    const after = setPackageVersion(before, i.next);
    if (after !== before) pending.push([PACKAGE_FILE, after]);
  }

  if (existsSync(abs(CHANGELOG_FILE))) {
    const before = readFileSync(abs(CHANGELOG_FILE), "utf8");
    const after = i.reclaimFrom
      ? changelogReclaim(before, i.reclaimFrom, i.next, i.date)
      : changelogInsert(before, i.next, i.date, i.level, i.entry);
    if (after !== before) pending.push([CHANGELOG_FILE, after]);
  }

  // atomicWrite (tmp+rename), not writeFileSync: a crash mid-write would
  // otherwise leave a TRUNCATED VERSION or CHANGELOG behind, and the next run
  // reads that file to decide what this branch already claimed. Same helper the
  // rest of the pack uses for state it must never half-write.
  for (const [rel, content] of pending) atomicWrite(abs(rel), content);
  return pending.map(([rel]) => rel);
}

// -- the decision -------------------------------------------------------------

export interface PlanInput {
  base: Version; // origin/<base>'s VERSION -- the floor the slot is picked above
  branch: Version; // the VERSION currently on this branch
  // The VERSION at `git merge-base origin/<base> HEAD` -- what this branch
  // INHERITED. `branch !== fork` is the only sound test for "this branch already
  // claimed", and the reason it is not `branch !== base`: merges are serialized,
  // so origin/<base> moves under every lane during a drain. A branch cut at
  // 1.0.1.0 while another lane merged 1.0.2.0 has branch !== base while having
  // claimed nothing, and reading that as a re-claim sent changelogReclaim looking
  // for a "## [1.0.1.0]" heading -- which exists, as a HISTORICAL RELEASE -- and
  // rewrote it. The fork point does not move when the base does.
  fork: Version;
  claimed: ClaimedSlot[]; // every OTHER open PR's claim
  labels: string[];
  bumpLabels?: Record<string, Bump>;
}

export interface ClaimPlan {
  action: "claim" | "reclaim" | "keep";
  version: string;
  level: Bump;
  levelFrom?: string;
  ceiling: string;
  ceilingFrom?: ClaimedSlot;
  reclaimFrom?: string;
  reason: string;
}

// Pure: what this branch should claim, given the base, its own current version,
// the outstanding claims and its labels. Every branch of the CLI's behavior is
// decided here so the whole decision is gate-testable without git or GitHub.
export function planClaim(i: PlanInput): ClaimPlan {
  const { level, from: levelFrom } = bumpLevelFor(i.labels, i.bumpLabels);
  const pick = nextFreeSlot(i.base, i.claimed, level);
  const version = fmtVersion(pick.version);
  const base = fmtVersion(i.base);
  const branch = fmtVersion(i.branch);
  const shared = {
    level,
    ...(levelFrom === undefined ? {} : { levelFrom }),
    ceiling: fmtVersion(pick.ceiling),
    ...(pick.ceilingFrom === undefined ? {} : { ceilingFrom: pick.ceilingFrom }),
  };

  // Untouched branch: VERSION still reads exactly what this branch inherited.
  if (compareVersions(i.branch, i.fork) === 0) {
    return { action: "claim", version, ...shared, reason: `${base} (base) + ${level} -> ${version}` };
  }

  // Already claimed. Re-point ONLY when the queue moved ABOVE this branch's
  // claim; a claim that is still the highest thing around is left alone, which
  // is what makes re-running the command on an unchanged queue a no-op rather
  // than a version-inflating ratchet.
  if (compareVersions(pick.version, i.branch) > 0) {
    return {
      action: "reclaim",
      version,
      ...shared,
      reclaimFrom: branch,
      reason: `this branch already claimed ${branch}, but the queue moved to ${shared.ceiling} -- re-pointing to ${version}`,
    };
  }
  return {
    action: "keep",
    version: branch,
    ...shared,
    reason: `this branch already claims ${branch}, still free (next slot would be ${version})`,
  };
}

// -- git ----------------------------------------------------------------------

// stdout and stderr stay SEPARATE. `out` is parsed as a value -- a sha fed
// straight back to `git show`, a branch name, a version string -- and git writes
// advice and warnings (CRLF conversion, detached HEAD, hints) to stderr while a
// command still exits 0. Concatenating them appends that text to the value, so a
// warning on a `merge-base` turns the next `show <sha>:VERSION` into a lookup of
// a ref that does not exist. stderr is kept for the error message, which is the
// only thing it is good for here.
export interface GitResult {
  code: number;
  out: string;
  err?: string;
}

export type GitRunner = (args: string[]) => GitResult;

export const realGit: GitRunner = (args) => {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const d = new TextDecoder();
  return { code: p.exitCode ?? 1, out: d.decode(p.stdout).trim(), err: d.decode(p.stderr).trim() };
};

// `allowFailure` returns "" instead of throwing, for the one read whose FAILURE
// is itself a meaningful answer (`rev-list origin/<branch>..HEAD` on a branch the
// remote has never seen). Every other call throws, because a git command that
// could not answer is not evidence.
function git(
  run: GitRunner,
  worktree: string,
  args: string[],
  what: string,
  opts: { allowFailure?: boolean } = {}
): string {
  const r = run(["-C", worktree, ...args]);
  if (r.code !== 0) {
    if (opts.allowFailure) return "";
    throw new ZError(`${what} failed (git exited ${r.code}): ${[r.err, r.out].filter(Boolean).join(" ") || "no output"}`);
  }
  return r.out.trim();
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `z-version <command> [args]

  claim --ticket <N> --worktree <W> --base <B> [--title <T>]
        [--entry-file <F>] [--title-out <F>] [--version-path <P>]
        [--date <YYYY-MM-DD>] [--dry-run] [--slug <name>]

    Claims this branch's version slot and commits it. Reads origin/<B>'s VERSION
    and every OTHER open PR's claimed VERSION, derives the bump level from
    ticket #N's labels, writes VERSION + package.json + CHANGELOG.md, then
    commits and pushes. Prints the decision as JSON.

    --entry-file  a CHANGELOG entry for what shipped (the one latent input).
                  Absent or empty falls back to "- <ticket title> (#N)".
    --title-out   writes "v<version> <title>" here for \`gh pr create --title\`.
    --dry-run     decide and print, write nothing.

  Exit 0 = a version is claimed on the branch (including an unchanged re-run).
  Any nonzero = no claim was made; do not open or merge the PR.`;

const COMMANDS = new Set(["claim"]);

// `boardFor` and `gitRunner` are the two seams, same injection style as
// lib/board.ts's main(): the gate tests drive the whole CLI edge -- what it
// prints, what it writes, and what it EXITS with -- against a fixture board and
// a recording git, with no network and no remote.
export async function main(
  argv: string[],
  boardFor: (slug?: string) => Board = (slug) => new Board(loadConfig(slug), ghExecutor()),
  configFor: (slug?: string) => BoardConfig = (slug) => loadConfig(slug),
  gitRunner: GitRunner = realGit
): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!COMMANDS.has(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }

  try {
    const { flags } = parseFlags(argv.slice(1), ["dry-run"]);
    const slug = str(flags, "slug");
    const ticketRaw = requireFlag(flags, "ticket");
    const ticket = Number(ticketRaw);
    if (!Number.isInteger(ticket) || ticket <= 0) {
      throw new ZError(`--ticket must be an issue number, got ${JSON.stringify(ticketRaw)}.`);
    }
    const worktree = resolve(requireFlag(flags, "worktree"));
    if (!existsSync(worktree)) throw new ZError(`Version claim: worktree ${worktree} does not exist.`);
    const baseBranch = requireFlag(flags, "base");
    const versionPath = str(flags, "version-path") ?? VERSION_FILE;
    const dryRun = flags["dry-run"] === true;
    // The CLI boundary owns the clock, like every other entrypoint in the pack;
    // --date makes the CHANGELOG heading a fixed string under test.
    const date = str(flags, "date") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ZError(`--date must be YYYY-MM-DD, got ${JSON.stringify(date)}.`);
    }

    // `git -C <dir>` ASCENDS out of a directory that is not a working tree: it
    // exits 0 and answers for the ENCLOSING repo. So an empty leftover
    // `.worktrees/ticket-<N>` -- the exact shape reconcile's force-remove leaves
    // behind -- would hand back the MAIN checkout's branch, its HEAD, and its
    // merge base, and the claim would be computed for one branch and committed
    // to another. existsSync above cannot see this: the directory is there.
    //
    // Comparing the toplevel against the path we were given is the check, and it
    // must come FIRST, before any read whose answer it would invalidate.
    const top = git(gitRunner, worktree, ["rev-parse", "--show-toplevel"], `resolving ${worktree} to a git working tree`);
    if (resolve(top) !== worktree) {
      throw new ZError(
        `Version claim: ${worktree} is not the root of a git working tree -- git resolved it to ${resolve(top)}. ` +
          `A claim computed there would be measured on the wrong branch and committed to the wrong checkout.`
      );
    }

    // Fetch first: the base moved under this branch every time another lane
    // merged during this drain, and a claim computed off a stale base picks a
    // slot that is already on main.
    git(gitRunner, worktree, ["fetch", "origin", baseBranch, "--quiet"], `fetching origin/${baseBranch}`);
    const branchName = git(gitRunner, worktree, ["rev-parse", "--abbrev-ref", "HEAD"], "reading the branch name");

    // Being a git root is not the same as being THIS TICKET's checkout. The
    // toplevel check above rejects a non-worktree directory; this rejects a
    // valid worktree that belongs to something else, which is the same lesson
    // #248 learned about the merge gate: "did the agent type the right path" is
    // not an acceptable last line of defence when the next step commits.
    //
    // Two refusals, deliberately narrow so a human running this on an ordinary
    // feature branch still works:
    //  * the BASE branch, which must never receive a claim commit directly;
    //  * another lane's `z/ticket-<M>-*` branch (isLaneBranch, the same
    //    predicate the merge gate binds with -- imported, not re-implemented,
    //    so the two can never drift).
    if (branchName === baseBranch) {
      throw new ZError(
        `Version claim: ${worktree} is on ${baseBranch} itself. A claim is committed to a ticket's branch, never to the base.`
      );
    }
    if (/^z\/ticket-\d+-/.test(branchName) && !isLaneBranch(branchName, ticket)) {
      throw new ZError(
        `Version claim: ${worktree} is on ${branchName}, which is another ticket's lane branch, not #${ticket}'s. ` +
          `The labels were read from #${ticket}; committing the claim here would put it on the wrong ticket's work.`
      );
    }

    const baseRaw = git(gitRunner, worktree, ["show", `origin/${baseBranch}:${versionPath}`], `reading origin/${baseBranch}:${versionPath}`);
    const base = parseVersion(baseRaw);
    if (!base) {
      throw new ZError(`origin/${baseBranch}:${versionPath} is ${JSON.stringify(baseRaw.trim())}, not a MAJOR.MINOR.PATCH.MICRO version.`);
    }
    // What this branch INHERITED, read at the fork point rather than at the
    // moving base -- see PlanInput.fork for the historical-heading rewrite this
    // prevents.
    const forkPoint = git(gitRunner, worktree, ["merge-base", `origin/${baseBranch}`, "HEAD"], `finding the merge base with origin/${baseBranch}`);
    const forkRaw = git(gitRunner, worktree, ["show", `${forkPoint}:${versionPath}`], `reading ${versionPath} at the merge base`);
    const fork = parseVersion(forkRaw);
    if (!fork) {
      throw new ZError(`${versionPath} at the merge base (${forkPoint}) is ${JSON.stringify(forkRaw.trim())}, not a MAJOR.MINOR.PATCH.MICRO version.`);
    }
    // Read from the COMMITTED tree, never from disk. "Has this branch claimed?"
    // must be answered by what is committed, because the whole point of the
    // answer is to decide whether a commit still has to happen. Reading the
    // working tree conflated "claimed" with "a previous attempt wrote the file
    // and then failed to commit it": the retry saw VERSION already bumped,
    // resolved to `keep`, and exited 0 having committed NOTHING -- so the PR was
    // opened from a branch whose HEAD still carried the old version, which is
    // precisely the vacuous state per-PR claiming exists to remove.
    const branchRaw = git(gitRunner, worktree, ["show", `HEAD:${versionPath}`], `reading ${versionPath} at HEAD`);
    const branch = parseVersion(branchRaw);
    if (!branch) {
      throw new ZError(`${versionPath} at HEAD is ${JSON.stringify(branchRaw.trim())}, not a MAJOR.MINOR.PATCH.MICRO version.`);
    }

    // ...and the files this command owns must match HEAD before it writes.
    //
    // Two failures close together here. A previous attempt that died between the
    // write and the commit leaves them dirty, and re-applying on top would
    // insert a SECOND CHANGELOG section for the same claim. And `git commit`
    // commits the whole index, so anything already staged -- by a conflict
    // resolution, by a stray `git add` -- would ride into the version-claim
    // commit unrelated. Refusing is the only answer that neither corrupts the
    // file nor silently ships someone else's edit; the message says exactly how
    // to clear it, and re-running afterwards is a no-op.
    const owned = [versionPath, PACKAGE_FILE, CHANGELOG_FILE].filter((f) => existsSync(join(worktree, f)));
    const dirty = git(gitRunner, worktree, ["status", "--porcelain", "--", ...owned], "checking for uncommitted changes");
    if (dirty) {
      throw new ZError(
        `Version claim: these files have uncommitted changes, so a claim written now could double-write them:\n${dirty}\n` +
          `That is usually a previous claim attempt that failed after writing. Clear them ` +
          `(\`git -C ${worktree} checkout -- ${owned.join(" ")}\`) and re-run.`
      );
    }

    // Both reads fail LOUD (no catch): a claim computed without the ticket's
    // labels or without the queue is a guess, and an unnoticed collision is
    // exactly the failure per-PR claiming exists to remove. The merge prompt
    // maps a nonzero exit here to BLOCKED.
    const board = boardFor(slug);
    const lookup = await board.item(ticket);
    if (!lookup.present) {
      throw new ZError(`Ticket #${ticket} is not on the board (${lookup.reason}), so its labels cannot set a bump level.`);
    }
    const claimed = (await board.openPrVersions(versionPath))
      .filter((c) => c.branch !== branchName) // this branch's own PR is not competition
      .map((c) => ({ pr: c.number, branch: c.branch, version: c.version }));

    const plan = planClaim({
      base,
      branch,
      fork,
      claimed,
      labels: lookup.item.labels ?? [],
      bumpLabels: configFor(slug).versionBumpLabels,
    });

    const title = str(flags, "title") ?? lookup.item.title;
    const prTitle = `v${plan.version} ${title}`;
    const out = { ticket, branch: branchName, prTitle, claimed, ...plan };

    if (dryRun) {
      console.log(JSON.stringify(out, null, 2));
      writeTitle(flags, prTitle);
      return 0;
    }

    // A claim only counts once the REMOTE has it -- the PR is opened from the
    // remote branch, and gstack's /review reads the version from there. So the
    // keep path is not a no-op, it is a verification: a previous attempt that
    // committed and then failed to push would otherwise report "already claims
    // 1.0.2.0" forever while the remote branch carried none of it. Pushing here
    // repairs exactly that, and is a no-op when the remote is already current.
    if (plan.action === "keep") {
      const unpushed = git(
        gitRunner,
        worktree,
        ["rev-list", "--count", `origin/${branchName}..HEAD`],
        `checking whether ${branchName} is pushed`,
        { allowFailure: true }
      );
      // A branch with no remote counterpart yet answers with a failure, not "0";
      // both mean "the remote does not have this commit", so both push.
      const pushed = unpushed === "0";
      if (!pushed) git(gitRunner, worktree, ["push", "origin", "HEAD"], "pushing the existing version claim");
      console.log(JSON.stringify({ ...out, pushed: true, repushed: !pushed }, null, 2));
      writeTitle(flags, prTitle);
      return 0;
    }

    // An --entry-file that was NAMED but is absent is a broken artifact path, not
    // an omitted option: the caller believed it wrote prose there. Falling back
    // silently commits the ticket title while the real entry is lost, and an
    // unattended caller cannot tell the two apart. Absent flag -> fallback;
    // named-but-missing -> refuse.
    const entryFile = str(flags, "entry-file");
    if (entryFile !== undefined && !existsSync(entryFile)) {
      throw new ZError(`--entry-file ${entryFile} does not exist. Write the CHANGELOG entry there first, or omit the flag to use the ticket title.`);
    }
    const written = entryFile ? readFileSync(entryFile, "utf8").trim() : "";
    const entry = written || `- ${lookup.item.title} (#${ticket})`;
    // Checked BEFORE anything is written: a refused entry must leave the branch
    // exactly as it was, not half-claimed. The fallback goes through the same
    // gate as agent prose -- a ticket title is untrusted too (z-plan writes it
    // from a spec), and one carrying a `## [` line would corrupt the file just
    // as thoroughly.
    assertUsableEntry(entry);

    const touched = applyClaim({
      worktree,
      versionPath,
      next: plan.version,
      level: plan.level,
      date,
      entry,
      ...(plan.reclaimFrom === undefined ? {} : { reclaimFrom: plan.reclaimFrom }),
    });

    git(gitRunner, worktree, ["add", "--", ...touched], "staging the version claim");
    // `--only <paths>` commits THOSE PATHS and nothing else, whatever else the
    // index holds. A bare `git commit` commits the entire index, so a path
    // staged by a conflict resolution would ride into the version-claim commit
    // silently. The clean-tree check above makes that unlikely; this makes it
    // impossible, and the two guard different windows (that one runs before the
    // write, this one at the commit).
    git(
      gitRunner,
      worktree,
      ["commit", "-m", `chore: claim v${plan.version} for #${ticket}`, "--only", "--", ...touched],
      "committing the version claim"
    );
    // `HEAD` rather than the branch name: the worktree is on the lane branch by
    // construction, and pushing HEAD needs no upstream to already be configured.
    git(gitRunner, worktree, ["push", "origin", "HEAD"], "pushing the version claim");

    console.log(JSON.stringify({ ...out, touched }, null, 2));
    writeTitle(flags, prTitle);
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

function writeTitle(flags: Record<string, string | boolean>, prTitle: string): void {
  const path = str(flags, "title-out");
  if (path) writeFileSync(path, prTitle, "utf8");
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
