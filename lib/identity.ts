// Makes the owner's bot-vs-human-account choice for the loop's GitHub
// identity (issue #66) durable and re-checkable. The loop's actual identity
// RESOLUTION is untouched by this file and stays exactly where it always
// was -- `ME=$(gh api user -q .login)` in z-loop/SKILL.md Step 0, the single
// source of truth for the session name, lane locks, and board claims. This
// file only answers two questions the SKILL.md setup flows need:
//   - "has this project already been asked?" (identityState) -- z-setup's
//     identity step (AC5/AC7) and z-update's re-check (AC6) both gate on this
//     before deciding whether to raise the AskUserQuestion.
//   - "record the answer" (recordIdentityChoice) -- the one piece that has to
//     be code rather than prose: it patches ONLY the `identity` key into the
//     on-disk config.json, preserving every sibling field byte-for-byte and
//     stamping `recordedAt` from a real clock (date math never happens in a
//     model reply). Never stores a second copy of a login.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { atomicWrite, handleCliError, parseFlags, requireFlag, str } from "./cli.ts";
import {
  type BoardConfig,
  type IdentityChoice,
  type IdentityRecord,
  configPath,
  loadConfig,
  ZError,
} from "./config.ts";
import { validateConfig } from "./config-schema.ts";

export type IdentityState = "unset" | IdentityChoice;

// Pure: what state a loaded config's identity block represents. "unset" is
// what every project created before issue #66 reads as -- z-update's
// re-check (AC6) prompts on "unset" and never on "bot"/"human", which is
// what makes "already chosen" durably non-re-prompting.
export function identityState(cfg: Pick<BoardConfig, "identity">): IdentityState {
  return cfg.identity?.mode ?? "unset";
}

export interface RecordIdentityOptions {
  mode: IdentityChoice;
  tokenLocation?: string;
  now?: () => string; // injectable for tests; defaults to new Date().toISOString()
}

// Patches ONLY the `identity` key into the on-disk config.json, preserving
// every sibling field byte-for-byte. Deliberately reads the RAW file with
// JSON.parse rather than lib/config.ts's loadConfig(): loadConfig's return
// value is filled with resolved defaults (maxLanes, quota, ...) that must
// never be baked back into the file -- same discipline lib/setup-board.ts's
// priorOptionalFields uses for stageModels/quota/notifications/
// adversarialMode. Re-validates the merged object with validateConfig before
// writing, so a caller can never corrupt config.json (same discipline as
// setup-board.ts's writeConfig) -- including rejecting an invalid `mode` at
// the write site, not just at the CLI's flag-parsing site.
export function recordIdentityChoice(
  slug: string,
  opts: RecordIdentityOptions,
  home: string = homedir()
): BoardConfig {
  const path = configPath(slug, home);
  if (!existsSync(path)) {
    throw new ZError(`No zstack config for "${slug}" at ${path}. Run /z-setup first.`);
  }
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Config at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const recordedAt = (opts.now ?? (() => new Date().toISOString()))();
  const record: IdentityRecord = {
    mode: opts.mode,
    recordedAt,
    ...(opts.tokenLocation ? { tokenLocation: opts.tokenLocation } : {}),
  };
  raw.identity = record;
  const validated = validateConfig(raw); // throws loudly on any structural break, incl. a bad mode
  atomicWrite(path, JSON.stringify(validated, null, 2) + "\n");
  return validated;
}

// -- CLI ----------------------------------------------------------------------
const USAGE = `identity <command> [flags]

  state  --slug S
         print {"state": "unset"|"bot"|"human"} for the project's recorded
         identity choice (issue #66). z-setup/SKILL.md (AC5/AC7) and
         z-update/SKILL.md (AC6) gate the AskUserQuestion prompt on this.
  record --slug S --mode bot|human [--token-location TEXT]
         record the owner's choice into config.json (atomic, validated).
         TEXT is a human-facing note of where the bot's token/gh-auth
         profile lives (e.g. "GH_TOKEN env var in the loop's launch
         script") -- never a login or the token itself.`;

function parseIdentityChoice(v: string): IdentityChoice {
  if (v === "bot" || v === "human") return v;
  throw new ZError(`--mode must be "bot" or "human", got ${JSON.stringify(v)}.`);
}

export async function main(argv: string[], home: string = homedir()): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    if (cmd === "state") {
      const { flags } = parseFlags(argv.slice(1));
      const cfg = loadConfig(requireFlag(flags, "slug"), home);
      console.log(JSON.stringify({ state: identityState(cfg) }));
      return 0;
    }
    if (cmd === "record") {
      const { flags } = parseFlags(argv.slice(1));
      const slug = requireFlag(flags, "slug");
      const mode = parseIdentityChoice(requireFlag(flags, "mode"));
      const tokenLocation = str(flags, "token-location");
      const cfg = recordIdentityChoice(slug, { mode, tokenLocation }, home);
      console.log(JSON.stringify({ state: identityState(cfg) }));
      return 0;
    }
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
