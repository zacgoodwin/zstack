// Shared CLI plumbing for every lib/*.ts entrypoint (issue #14 item 21). Each
// entrypoint used to hand-roll the same shapes -- --flag parsing, required-flag
// extraction, JSON file reads, the ZError->exit-1 epilogue -- plus the
// tmp+rename atomic write. One copy of each lives here; behavior is identical
// to the originals, so consolidating is a pure de-duplication.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ZError } from "./config.ts";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

// `--key value` pairs plus positionals, in one pass. A key listed in `booleans`
// consumes no value and stores true (e.g. --reconcile, --json, --force).
// `--key=value` is also accepted (split on the first `=`) as an alternative
// to the space-separated form; both spellings land in the same `flags[key]`.
// For a key listed in `booleans`, the `=` form coerces "true"/"false" to real
// booleans -- NOT the raw string -- so callers that strictly compare
// `flags.json === true` (lib/cost.ts, lib/locks.ts) see the same type
// regardless of which spelling the caller typed. Any other value after `=`
// on a boolean key (e.g. --json=maybe) is a loud usage error, matching the
// trailing-value-flag error below rather than silently storing a truthy
// string that `=== true` would then defeat.
// A non-boolean flag with no following token (the flag is the last arg, or
// followed by nothing) is a usage error, not a silent `undefined` value --
// callers reading it via `str()`/`requireFlag` used to see "flag missing"
// instead of "flag malformed", masking a typo'd command line.
export function parseFlags(args: string[], booleans: string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        const key = body.slice(0, eq);
        const raw = body.slice(eq + 1);
        if (booleans.includes(key)) {
          if (raw === "true") flags[key] = true;
          else if (raw === "false") flags[key] = false;
          else throw new ZError(`Flag --${key} is boolean; got --${key}=${raw} (expected true or false).`);
        } else {
          flags[key] = raw;
        }
        continue;
      }
      const key = body;
      if (booleans.includes(key)) {
        flags[key] = true;
      } else {
        const value = args[++i];
        if (value === undefined) throw new ZError(`Flag --${key} needs a value (got none).`);
        flags[key] = value;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// A flag's string value, or undefined when absent or boolean.
export function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function requireFlag(flags: ParsedArgs["flags"], name: string): string {
  const v = str(flags, name);
  if (!v) throw new ZError(`Missing required --${name}.`);
  return v;
}

export function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Cannot read JSON at ${path}: ${(e as Error).message}`);
  }
}

// The shared main() epilogue: an actionable failure (ZError) prints its message
// and exits 1; anything else is a bug and rethrows with its stack.
export function handleCliError(e: unknown): number {
  if (e instanceof ZError) {
    console.error(e.message);
    return 1;
  }
  throw e;
}

// tmp + rename: rename() is atomic on the same volume on POSIX and NTFS, so a
// concurrent reader never observes a half-written file; the tmp file sits next
// to the target (same volume) with a pid+timestamp suffix, and flag "wx"
// (exclusive create) turns the rare suffix collision into an EEXIST we resolve
// by regenerating the suffix once instead of silently clobbering another
// writer's tmp. mode 0o600 (owner-only) is set on the tmp file BEFORE the
// rename: locks and settings.json (which can carry blanket auto-approval) must
// never be briefly world-readable. (No-op on Windows, where fs modes don't map
// to POSIX perms.) This is the union of the original copies' guarantees -- the
// endloop/loop copies lacked the 0o600, and owner-only on a loop counter or
// state file is harmless.
//
// On Windows an antivirus/indexer can hold the destination open for a moment,
// so a transient EPERM/EACCES/EBUSY from rename gets a bounded retry (3
// attempts, 30ms apart); any other error, or the final attempt, rethrows after
// best-effort unlinking the tmp so failures never leave tmp files accumulating.
// Deliberately no fsync: these files are coordination state (locks, counters,
// settings), not durability-critical data -- a crash losing the very last
// update is already handled by the reconcile path.
const RETRYABLE_RENAME = ["EPERM", "EACCES", "EBUSY"];

export function atomicWrite(
  path: string,
  content: string,
  // Test-only seam for simulating transient rename failures; callers never pass it.
  rename: (from: string, to: string) => void = renameSync,
): void {
  // Root cause, not the ".": Bun's mkdirSync THROWS on a directory that already
  // exists even under `recursive` (Node's is a no-op there). dirname() hands it
  // exactly those every day -- "." for a bare `state.json`, ".." for
  // `../up.json` (EEXIST), "C:\" for a drive-root path (EPERM) -- so every CLI
  // taking a state/lock path used to die with a raw stack before writing
  // anything. An existing directory needs nothing created; resolve() first so
  // the check reads the same path mkdirSync would.
  const dir = resolve(dirname(path));
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e: any) {
      // Lost the race to a concurrent writer -- which, per the above, throws
      // here rather than no-op'ing. Only a genuinely absent dir is fatal.
      if (e?.code !== "EEXIST" || !existsSync(dir)) throw e;
    }
  }
  let tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        rename(tmp, path);
        return;
      } catch (e: any) {
        if (attempt >= 3 || !RETRYABLE_RENAME.includes(e?.code)) throw e;
        Bun.sleepSync(30);
      }
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {} // best-effort: the rename error is the one worth surfacing
    throw e;
  }
}
