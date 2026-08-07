// Run identity (#322, epic #321 contract C1): one drain = one runId = one
// artifact root (runs/<runId>/ under the project's loop state dir).
//
// Its own module because BOTH sides of the artifact pipeline need it -- the
// writer (lib/transcripts.ts tags and collects into the run root) and the
// reader (lib/cost.ts prices exactly one run root) -- and transcripts.ts
// already imports cost.ts for KNOWN_STAGES, so housing this in either would
// make the two-file cycle the fence-tracker duplication (#314) warns about;
// one owner, imported by both, keeps the format from ever forking.
//
// The lifecycle rule (epic #321): a runId is minted exactly when a NEW
// state.json is created (lib/loop.ts ingest with no previous state), kept
// verbatim across every resume of that state file, and retired when
// end-of-loop archives the state into its run directory -- so the next drain
// mints fresh. No other path creates or changes a runId.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ZError } from "./config.ts";

// Format: run-<UTCyyyymmdd-hhmmss>-<4hex>. Readable and sortable on purpose --
// unlike spawnTag there is no blindness contract here (the runId never reaches
// a stage prompt on its own; it reaches agents only inside the already-opaque
// spawnTag digest), so the operator-facing directory name can say when the run
// started. The 4-hex suffix (crypto) breaks the tie when two runs start within
// the same second.
const RUN_ID_RE = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
}

// `suffix` is injectable for tests only; production always takes the crypto
// default. Throws on a malformed injected suffix rather than minting an id
// isRunId would then reject.
export function mintRunId(nowMs: number, suffix?: string): string {
  const d = new Date(nowMs);
  if (!Number.isFinite(nowMs) || Number.isNaN(d.getTime())) {
    throw new ZError(`mintRunId: nowMs must be a millisecond epoch, got ${JSON.stringify(nowMs)}.`);
  }
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `-${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
  const hex = suffix ?? randomBytes(2).toString("hex");
  const id = `run-${stamp}-${hex}`;
  if (!isRunId(id)) {
    throw new ZError(`mintRunId: minted "${id}" which is not a valid runId -- suffix must be 4 lowercase hex chars.`);
  }
  return id;
}

// The canonical on-disk home of one stage spawn's artifacts (transcripts now,
// verdict.json in C2/#323): <stateDir>/runs/<runId>/t<ticket>/<stage>-<attempt>.
// Composed HERE, in code, and nowhere else -- z-loop/SKILL.md calls transcripts'
// `dest` verb instead of assembling the path in prose, so attempt collisions
// (#210) and cross-run bleed (#212) are structurally impossible rather than
// convention. Distinct attempts get distinct directories by construction.
export function stageDest(stateDir: string, runId: string, ticket: number, stage: string, attempt: number): string {
  if (!isRunId(runId)) {
    throw new ZError(`stageDest: "${runId}" is not a runId (run-<yyyymmdd>-<hhmmss>-<4hex>).`);
  }
  return join(stateDir, "runs", runId, `t${ticket}`, `${stage}-${attempt}`);
}
