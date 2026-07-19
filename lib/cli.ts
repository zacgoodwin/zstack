// Shared CLI plumbing for every lib/*.ts entrypoint (issue #14 item 21). Each
// entrypoint used to hand-roll the same shapes -- --flag parsing, required-flag
// extraction, JSON file reads, the ZError->exit-1 epilogue -- plus the
// tmp+rename atomic write. One copy of each lives here; behavior is identical
// to the originals, so consolidating is a pure de-duplication.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ZError } from "./config.ts";

export { ZError } from "./config.ts";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

// `--key value` pairs plus positionals, in one pass. A key listed in `booleans`
// consumes no value and stores true (e.g. --reconcile, --json, --force).
export function parseFlags(args: string[], booleans: string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (booleans.includes(key)) flags[key] = true;
      else flags[key] = args[++i];
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
// to the target (same volume) with a pid+timestamp suffix so writers never
// collide. mode 0o600 (owner-only) is set on the tmp file BEFORE the rename:
// locks and settings.json (which can carry blanket auto-approval) must never be
// briefly world-readable. (No-op on Windows, where fs modes don't map to POSIX
// perms.) This is the union of the original copies' guarantees -- the
// endloop/loop copies lacked the 0o600, and owner-only on a loop counter or
// state file is harmless.
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}
