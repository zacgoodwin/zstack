// Per-stage transcript collection (issue #190). A stage's spend is not one
// transcript: the adversarial reviewer spawns 3 skeptic sub-agents (#59), and
// every token they burn is the reviewer stage's cost. z-loop/SKILL.md Step 4
// used to say "take the file for that spawn" -- a LATENT step, so the skeptics'
// transcripts were simply never copied and every adversarial review's Actual
// undercounted by the majority of what it spent.
//
// This is the deterministic replacement (PRINCIPLES.md, latent vs
// deterministic): the harness already records exact parentage, so which files
// belong to a stage is a graph walk, not a judgment call. Claude Code writes
// each sub-agent as a sibling pair under the session's own directory:
//
//   ~/.claude/projects/<mangled-cwd>/<session-uuid>/subagents/
//       agent-<id>.jsonl       the sub-agent's transcript
//       agent-<id>.meta.json   {agentType, description, toolUseId, spawnDepth,
//                               parentAgentId?, model?}
//
// `parentAgentId` is absent exactly on the agents the top-level session spawned
// (verified: 50 of 50 spawnDepth-1 metas in a real drain carry no parent, 37 of
// 37 spawnDepth-2 metas do), so a stage agent is always parentless and its
// skeptics always point at it. Collecting a stage = find its own transcript,
// then take every descendant transitively.
//
// The rejected alternative was an mtime window: "copy every agent-*.jsonl
// written near this stage's" -- what #190's own ticket body proposed, and what
// was tried by hand during loop run 10. Three lanes run concurrently, so a
// sibling reviewer's skeptics interleave in the same flat directory; that sweep
// attributed 8 transcripts to a reviewer that had 3. Wall-clock proximity is not
// parentage, and there is no reason to guess when the parent id is on disk.
//
// Finding the stage's OWN transcript needs a token guaranteed to appear in its
// first user message, since the orchestrator never learns the agent id the
// harness assigned. `spawnTag` is that token: stage-prompts.ts stamps it into
// the prompt as an inert HTML comment, and the same string is passed back here.
// Ambiguity is resolved structurally, not by heuristic -- see findRootAgents.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { handleCliError, parseFlags, requireFlag, str } from "./cli.ts";
import { ZError } from "./config.ts";
import { mangleProjectDir, resolveSessionTranscript } from "./context-budget.ts";
import { KNOWN_STAGES } from "./cost.ts";
// The marker literal is owned by the module that EMITS it, so the format has one
// definition and this reader can never drift from the writer.
import { SPAWN_TAG_MARKER } from "./stage-prompts.ts";

// A stage spawn's identity: a deterministic, OPAQUE digest of
// <slug>/t<ticket>/<stage>/<attempt>.
//
// Opaque is the whole point, and it is the reviewer's blindness contract that
// forces it (stage-prompts.ts assertReviewerInput). The tag is stamped into the
// prompt, so a plain-text `zstack/t151/reviewer/2` would tell the adversarial
// reviewer that its diff is on review ATTEMPT 2 -- i.e. that an earlier review
// already rejected it. That is exactly the kind of prior-narrative hint the
// four-key gate exists to keep out; whether it biases the reviewer toward
// leniency ("presumably fixed") or severity is unknowable, which is why the
// contract says don't rather than measure it. Hashing removes the question.
//
// Deterministic, not a nonce: the orchestrator computes it twice from the same
// four facts (once for --spawn-tag, once for --tag) with nothing to remember in
// between, and a re-collection recomputes the same string. Traceability is not
// lost -- collect's --name carries the readable <stage>-<attempt> and its --dest
// the ticket, so the manifest and the written filenames still say what a file is.
export function spawnTag(slug: string, ticket: number, stage: string, attempt: number): string {
  const digest = createHash("sha256").update(`${slug}/t${ticket}/${stage}/${attempt}`).digest("hex");
  return `zs-${digest.slice(0, 12)}`;
}

// -- the harness's on-disk graph -----------------------------------------------

export interface AgentMeta {
  agentId: string;
  parentAgentId?: string;
  description?: string;
}

// Where this session's sub-agent transcripts live. resolveSessionTranscript
// returns the session's own <uuid>.jsonl; the sub-agent directory is its
// same-named SIBLING directory, so the path is derived, never re-globbed (a
// second glob could resolve a different session than the one we measured).
//
// Inherits resolveSessionTranscript's documented newest-mtime ceiling: a second
// Claude Code session in the same repo dir can win the race. Sub-agent files
// live one level down, so they never compete for "newest" themselves.
export function subagentsDirFor(cwd: string, home = homedir()): string | undefined {
  const session = resolveSessionTranscript(cwd, home);
  if (session === undefined) return undefined;
  return join(dirname(session), basename(session).replace(/\.jsonl$/i, ""), "subagents");
}

// Every agent-<id>.meta.json in the directory, as a flat list. A meta file that
// is missing, unreadable, or not valid JSON is SKIPPED and named on stderr
// rather than throwing: one unparseable sidecar must not cost the whole stage
// its cost attribution, and the agent it describes is still discoverable as a
// parentless candidate (which is the conservative reading -- see findRootAgents).
export function readAgentMetas(subagentsDir: string): { metas: AgentMeta[]; skipped: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch (e) {
    throw new ZError(`Cannot read the sub-agent transcript directory ${subagentsDir}: ${(e as Error).message}`);
  }
  const metas: AgentMeta[] = [];
  const skipped: string[] = [];
  for (const f of entries.sort()) {
    const m = /^agent-(.+)\.meta\.json$/.exec(f);
    if (!m) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(join(subagentsDir, f), "utf8"));
    } catch (e) {
      console.error(`transcripts: skipping ${f} -- unreadable agent metadata (${(e as Error).message}).`);
      skipped.push(f);
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      console.error(`transcripts: skipping ${f} -- agent metadata is not a JSON object.`);
      skipped.push(f);
      continue;
    }
    metas.push({
      agentId: m[1],
      parentAgentId: typeof parsed.parentAgentId === "string" ? parsed.parentAgentId : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    });
  }
  return { metas, skipped };
}

// How much of an agent-<id>.jsonl's first line we read looking for the spawn
// tag. Stage prompts are POINTER prompts (#57): the payload lives in
// input-<N>.json, so the prompt is size-invariant and the longest first line
// measured across a real drain's 174 sub-agent transcripts was 4,118 bytes. 64
// KiB is ~16x that and bounded, so scanning a directory never reads a 650 KB
// transcript in full just to check its opening line.
const FIRST_LINE_BYTES = 64 * 1024;

// The bounded prefix of a file's first line. Never throws: an unreadable or
// vanished file is simply not a candidate.
function firstLinePrefix(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.allocUnsafe(FIRST_LINE_BYTES);
    const n = readSync(fd, buf, 0, FIRST_LINE_BYTES, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

// Which agents' first user message carries this spawn tag, and of those, which
// are STAGE agents. Two filters, in order:
//
//  1. the tag appears in the first transcript line (the harness writes the
//     spawn prompt there verbatim, as `{"type":"user","message":{...}}`);
//  2. the agent has no parentAgentId.
//
// Filter 2 is the structural half. A sub-agent that echoed its parent's prompt
// -- a reviewer pasting its own header into a skeptic brief -- matches the tag
// too, and picking wrong would attribute a whole stage to one skeptic. Only the
// orchestrator's own spawns are parentless, so the stage agent is always in this
// set and an echoing descendant never is. Returned as a list so the caller
// decides what more-than-one means (it means the same tag was reused, which is
// a caller bug worth failing on, not a case to silently pick from).
export function findRootAgents(subagentsDir: string, tag: string, metas: AgentMeta[]): string[] {
  const hasParent = new Set(metas.filter((m) => m.parentAgentId !== undefined).map((m) => m.agentId));
  const needle = `${SPAWN_TAG_MARKER} ${tag}`;
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch (e) {
    throw new ZError(`Cannot read the sub-agent transcript directory ${subagentsDir}: ${(e as Error).message}`);
  }
  for (const f of entries.sort()) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    if (hasParent.has(m[1])) continue;
    if (firstLinePrefix(join(subagentsDir, f)).includes(needle)) found.push(m[1]);
  }
  return found;
}

// Every descendant of rootId, transitively, sorted by agent id. Excludes the
// root itself. A visited set makes a cyclic parent chain (which the harness
// should never write, and which we cannot verify it never will) terminate
// instead of hanging the collection step.
export function descendantsOf(metas: AgentMeta[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const m of metas) {
    if (m.parentAgentId === undefined) continue;
    const kids = children.get(m.parentAgentId) ?? [];
    kids.push(m.agentId);
    children.set(m.parentAgentId, kids);
  }
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    for (const kid of children.get(queue.shift()!) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      queue.push(kid);
    }
  }
  return out.sort();
}

// -- collection ----------------------------------------------------------------

export interface CollectedFile {
  agentId: string;
  role: "stage" | "descendant";
  file: string; // basename written under dest
}

export interface CollectResult {
  tag: string;
  root: string;
  dest: string;
  files: CollectedFile[];
  descendants: number;
  skippedMeta: string[];
}

// Descendants are named by their AGENT ID, not by a 1..k counter. A counter is
// only stable if the descendant set never changes between collections: insert a
// late-finishing skeptic and every later index shifts, leaving the previous
// run's file behind under a name that now duplicates a different agent's
// transcript. z-cost dedupes by requestId so the dollar total survives that, but
// the directory would be quietly wrong. Keying on the id makes re-collection
// idempotent by construction and lets a human trace any file back to its
// meta.json. stageOfFile (lib/cost.ts) splits on the FIRST "-", so
// `reviewer-2-sub-<id>.jsonl` still buckets under "reviewer".
function destName(name: string, agentId: string | null): string {
  return agentId === null ? `${name}.jsonl` : `${name}-sub-${agentId}.jsonl`;
}

export function collectTranscripts(opts: {
  subagentsDir: string;
  tag: string;
  dest: string;
  name: string;
}): CollectResult {
  const { metas, skipped } = readAgentMetas(opts.subagentsDir);
  const roots = findRootAgents(opts.subagentsDir, opts.tag, metas);
  if (roots.length === 0) {
    throw new ZError(
      `No stage transcript carries spawn tag "${opts.tag}" (${opts.name}) under ${opts.subagentsDir}. ` +
        `Either the stage prompt was built without --spawn-tag (so the tag never reached the agent), ` +
        `or the tag does not match the one the prompt was built with. This stage's tokens would go ` +
        `uncounted, so refusing to write a partial transcript set.`
    );
  }
  if (roots.length > 1) {
    throw new ZError(
      `Spawn tag "${opts.tag}" (${opts.name}) matches ${roots.length} orchestrator-spawned agents ` +
        `(${roots.join(", ")}) under ${opts.subagentsDir}. A tag names ONE spawn -- one ` +
        `slug/ticket/stage/attempt. Re-using an attempt number for two spawns makes their spend ` +
        `indistinguishable; refusing to guess.`
    );
  }
  const root = roots[0];
  mkdirSync(opts.dest, { recursive: true });
  const files: CollectedFile[] = [];
  for (const [agentId, role] of [[root, "stage"] as const, ...descendantsOf(metas, root).map((d) => [d, "descendant"] as const)]) {
    const file = destName(opts.name, role === "stage" ? null : agentId);
    copyFileSync(join(opts.subagentsDir, `agent-${agentId}.jsonl`), join(opts.dest, file));
    files.push({ agentId, role, file });
  }
  return {
    tag: opts.tag,
    root,
    dest: opts.dest,
    files,
    descendants: files.length - 1,
    skippedMeta: skipped,
  };
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `transcripts <command> [args]

  tag --slug <slug> --ticket <n> --stage <stage> --attempt <k>
        print the opaque spawn tag for one stage spawn (deterministic; the same
        four facts always print the same tag). Pass the SAME string to
        \`stage-prompts prompt ... --spawn-tag\` and to \`collect --tag\`.

  collect --tag <tag> --dest <dir> --name <stage>-<attempt>
          [--project-dir <dir>] [--subagents-dir <dir>]
        copy the stage agent's transcript and EVERY sub-agent it spawned
        (transitively) into <dir>, as <name>.jsonl and
        <name>-sub-<agentId>.jsonl, and print a JSON manifest. --project-dir
        defaults to the current working directory (the orchestrator's cwd);
        --subagents-dir overrides the resolved location outright.`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1));
    if (cmd === "tag") {
      const ticketArg = requireFlag(flags, "ticket");
      const attemptArg = requireFlag(flags, "attempt");
      const ticket = Number(ticketArg);
      const attempt = Number(attemptArg);
      if (!Number.isInteger(ticket) || ticket <= 0) throw new ZError(`--ticket must be a positive integer, got ${JSON.stringify(ticketArg)}.`);
      if (!Number.isInteger(attempt) || attempt <= 0) throw new ZError(`--attempt must be a positive integer, got ${JSON.stringify(attemptArg)}.`);
      // A typo'd stage would mint a perfectly valid-looking tag, and the
      // matching `--name <stage>-<attempt>` would then bucket every collected
      // file under "other" in the spend-by-stage table -- the reviewer's dollars
      // silently leaving the reviewer row. Same set lib/cost.ts prices against,
      // so the two can't disagree.
      const stage = requireFlag(flags, "stage");
      if (!KNOWN_STAGES.has(stage)) {
        throw new ZError(
          `--stage must be one of ${[...KNOWN_STAGES].join(", ")}, got ${JSON.stringify(stage)}.`
        );
      }
      console.log(spawnTag(requireFlag(flags, "slug"), ticket, stage, attempt));
      return 0;
    }
    if (cmd === "collect") {
      const tag = requireFlag(flags, "tag");
      const dest = requireFlag(flags, "dest");
      const name = requireFlag(flags, "name");
      const projectDir = str(flags, "project-dir") ?? process.cwd();
      const subagentsDir = str(flags, "subagents-dir") ?? subagentsDirFor(projectDir);
      if (subagentsDir === undefined) {
        throw new ZError(
          `No session transcript resolved under ${join(homedir(), ".claude", "projects", mangleProjectDir(projectDir))}, ` +
            `so the sub-agent directory is unknown. Pass --subagents-dir explicitly.`
        );
      }
      console.log(JSON.stringify(collectTranscripts({ subagentsDir, tag, dest, name })));
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
