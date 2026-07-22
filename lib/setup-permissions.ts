// The deterministic half of /z-setup's optional auto-approvals step (child
// C11, issue #12). Merges up to three permission layers into a Claude Code
// settings.json:
//
//   1. allowlist  -- specific Bash(git/gh/bun/bunx *) rules ONLY. Deliberately
//                    narrow: no Bash(bash *)/Bash(claude *) (arbitrary-command
//                    escape hatches) and no bare Edit/Write, so option B is a
//                    genuinely smaller blast radius than "full", not a rename of
//                    it. "full" grants everything anyway via the bypass hook.
//   2. bypassMode -- permissions.defaultMode: "bypassPermissions" +
//                    skipDangerousModePermissionPrompt/skipAutoPermissionPrompt
//   3. hook       -- a PermissionRequest hook that answers every prompt "allow"
//
// "full" writes all three; "allowlist" writes only the first. This is the
// only lever that works mid-session per the live incident this ticket is
// named for: defaultMode is read once at session startup, so a hook is the
// only thing a *running* session honors.
//
// The settings.json path is a parameter everywhere in this file -- it is
// NEVER defaulted to ~/.claude here. bin/z-setup-permissions's main() is the
// only place that computes the real path, so every test in
// tests/setup-permissions.test.ts is structurally incapable of touching the
// real file.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, handleCliError, parseFlags, str } from "./cli.ts";
import { ZError } from "./config.ts";

// -- desired shape ------------------------------------------------------------
// The allowlist tier: specific tool prefixes the loop actually shells out to and
// nothing more. Deliberately EXCLUDES Bash(bash *) / Bash(claude *) (which are
// arbitrary-command escape hatches equivalent to full bypass) and bare Edit /
// Write, so option B in z-setup is honestly the narrower, safer choice.
export const ALLOW_RULES = [
  "Bash(git *)",
  "Bash(gh *)",
  "Bash(bun *)",
  "Bash(bunx *)",
] as const;

// The fixed reason string this tool stamps on its own allow-hook. It doubles as
// the stable detection marker (hasPermissionRequestAllowHook): it is specific to
// us, so a foreign hook -- even one that answers "deny" but happens to mention
// the allow token -- never matches it.
export const HOOK_REASON = "blanket approval per user instruction";

// Proven live on 2026-07-18 (issue #12): the only hook event a running session
// re-checks, so it's the one lever that works mid-session. Single-quoted bash
// string with literal double quotes inside -- JSON.stringify escapes them on
// write, JSON.parse hands them back unescaped on read, so every in-memory
// comparison in this file works against the literal text below.
export const PERMISSION_REQUEST_HOOK_COMMAND =
  `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow","permissionDecisionReason":"${HOOK_REASON}"}}'`;

export function permissionRequestHookEntry(): { hooks: Array<{ type: string; command: string }> } {
  return { hooks: [{ type: "command", command: PERMISSION_REQUEST_HOOK_COMMAND }] };
}

export type PermissionsMode = "full" | "allowlist";

// -- layer detection (pure, read-only) ----------------------------------------

// Idempotence marker: does a PermissionRequest hook carry OUR reason string
// (HOOK_REASON)? Keyed off that fixed marker, not the bare "permissionDecision":
// "allow" token -- a deny-hook whose command text happens to contain the allow
// literal (e.g. in a comment or its own decision logic) is NOT a false positive,
// and a foreign allow-hook with a different reason isn't mistaken for ours, so
// `full` re-adds ours alongside it. Only our own prior write dedupes here.
export function hasPermissionRequestAllowHook(settings: any): boolean {
  const groups = settings?.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) return false;
  for (const g of groups) {
    const hooks = g?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      if (h?.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_REASON)) {
        return true;
      }
    }
  }
  return false;
}

export function hasBypassMode(settings: any): boolean {
  return (
    settings?.permissions?.defaultMode === "bypassPermissions" &&
    settings?.skipDangerousModePermissionPrompt === true &&
    settings?.skipAutoPermissionPrompt === true
  );
}

export function missingAllowRules(settings: any): string[] {
  const allow: unknown[] = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  return ALLOW_RULES.filter((r) => !allow.includes(r));
}

export interface LayerCheck {
  present: boolean;
  detail: string;
}
export interface CheckReport {
  hook: LayerCheck;
  bypassMode: LayerCheck;
  allowlist: LayerCheck;
}

// Acceptance criterion 2: each of the three layers reported independently.
export function checkLayers(settings: any): CheckReport {
  const hook = hasPermissionRequestAllowHook(settings);
  const bypassMode = hasBypassMode(settings);
  const missing = missingAllowRules(settings);
  return {
    hook: { present: hook, detail: hook ? "PermissionRequest allow hook present" : "no PermissionRequest hook answers allow" },
    bypassMode: {
      present: bypassMode,
      detail: bypassMode
        ? "defaultMode=bypassPermissions + both skip flags set"
        : "defaultMode/skipDangerousModePermissionPrompt/skipAutoPermissionPrompt not fully set",
    },
    allowlist: {
      present: missing.length === 0,
      detail: missing.length === 0 ? `all ${ALLOW_RULES.length} broad allow rules present` : `missing: ${missing.join(", ")}`,
    },
  };
}

// -- merge (pure: object in, object out; never touches disk) -----------------
export interface MergeResult {
  settings: any;
  changed: boolean;
  changes: string[];
}

// Read-modify-write MERGE: every existing key and rule not touched by this
// function's own additions survives untouched. Idempotent by construction --
// each addition is guarded by the same detector `check*`/`has*` uses, so a
// second call against the first call's output always reports changed: false.
export function mergeSettings(input: any, mode: PermissionsMode): MergeResult {
  const settings = structuredClone(input ?? {});
  const changes: string[] = [];

  settings.permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
  settings.permissions.allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  for (const rule of ALLOW_RULES) {
    if (!settings.permissions.allow.includes(rule)) {
      settings.permissions.allow.push(rule);
      changes.push(`+ permissions.allow: ${rule}`);
    }
  }

  if (mode === "full") {
    if (settings.permissions.defaultMode !== "bypassPermissions") {
      settings.permissions.defaultMode = "bypassPermissions";
      changes.push(`+ permissions.defaultMode: bypassPermissions`);
    }
    if (settings.skipDangerousModePermissionPrompt !== true) {
      settings.skipDangerousModePermissionPrompt = true;
      changes.push(`+ skipDangerousModePermissionPrompt: true`);
    }
    if (settings.skipAutoPermissionPrompt !== true) {
      settings.skipAutoPermissionPrompt = true;
      changes.push(`+ skipAutoPermissionPrompt: true`);
    }
    if (!hasPermissionRequestAllowHook(settings)) {
      settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
      settings.hooks.PermissionRequest = Array.isArray(settings.hooks.PermissionRequest) ? settings.hooks.PermissionRequest : [];
      settings.hooks.PermissionRequest.push(permissionRequestHookEntry());
      changes.push(`+ hooks.PermissionRequest: allow hook`);
    }
  }

  return { settings, changed: changes.length > 0, changes };
}

// Inverse of mergeSettings: strip EXACTLY the entries the apply path writes and
// nothing else, so `--remove` is a clean undo for either tier. Keyed off the same
// detectors the merge/check use -- the ALLOW_RULES allowlist, the bypass keys, and
// the PermissionRequest hook carrying HOOK_REASON -- so a foreign allow rule, a
// user's own defaultMode, or a foreign PermissionRequest hook survives untouched.
// Containers this file itself creates (permissions, permissions.allow, hooks,
// hooks.PermissionRequest) are deleted only when removal leaves them empty, so a
// full merge followed by a remove round-trips an empty settings object back to
// empty. Idempotent: a second call reports changed: false.
export function removeSettings(input: any): MergeResult {
  const settings = structuredClone(input ?? {});
  const changes: string[] = [];

  const perms = settings.permissions;
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    if (Array.isArray(perms.allow)) {
      for (const rule of ALLOW_RULES) {
        const i = perms.allow.indexOf(rule);
        if (i !== -1) {
          perms.allow.splice(i, 1);
          changes.push(`- permissions.allow: ${rule}`);
        }
      }
      if (perms.allow.length === 0) delete perms.allow;
    }
    if (perms.defaultMode === "bypassPermissions") {
      delete perms.defaultMode;
      changes.push(`- permissions.defaultMode: bypassPermissions`);
    }
    if (Object.keys(perms).length === 0) delete settings.permissions;
  }

  if (settings.skipDangerousModePermissionPrompt === true) {
    delete settings.skipDangerousModePermissionPrompt;
    changes.push(`- skipDangerousModePermissionPrompt: true`);
  }
  if (settings.skipAutoPermissionPrompt === true) {
    delete settings.skipAutoPermissionPrompt;
    changes.push(`- skipAutoPermissionPrompt: true`);
  }

  // Hook removal is per-hook, not per-group: drop only the command carrying our
  // reason marker, keep every other hook in the same group, then drop a group
  // emptied by that removal. A foreign group (SessionStart, or a deny-hook, or a
  // differently-worded allow-hook) is preserved.
  const groups = settings?.hooks?.PermissionRequest;
  if (Array.isArray(groups)) {
    let removedHook = false;
    const kept: any[] = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const keptHooks = g.hooks.filter(
        (h: any) => !(h?.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_REASON)),
      );
      if (keptHooks.length !== g.hooks.length) removedHook = true;
      if (keptHooks.length > 0) kept.push({ ...g, hooks: keptHooks });
    }
    if (removedHook) {
      changes.push(`- hooks.PermissionRequest: allow hook`);
      if (kept.length === 0) {
        delete settings.hooks.PermissionRequest;
        if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      } else {
        settings.hooks.PermissionRequest = kept;
      }
    }
  }

  return { settings, changed: changes.length > 0, changes };
}

// -- file I/O ------------------------------------------------------------------

// A settings.json that does not exist yet (first run on a fresh machine) and
// an empty `{}` file are the same starting point: bootstrap from nothing.
// Anything else that fails to parse as a JSON object is a loud, named error --
// never silently treated as empty, which would risk clobbering a file the
// user just fat-fingered.
export function readSettingsFile(path: string): any {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ZError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ZError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  assertSettingsShape(parsed, path);
  return parsed;
}

// Trust-boundary validation (JSON-validate "before"): the root must be an
// object, and the two sub-trees this file writes into must already be the
// right shape if present, so a hand-broken settings.json fails loudly here
// instead of throwing a confusing TypeError three functions later.
function assertSettingsShape(value: any, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ZError(`${path} must contain a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}.`);
  }
  if (value.permissions !== undefined && (typeof value.permissions !== "object" || value.permissions === null || Array.isArray(value.permissions))) {
    throw new ZError(`${path}: "permissions" must be an object.`);
  }
  if (value.permissions?.allow !== undefined && !Array.isArray(value.permissions.allow)) {
    throw new ZError(`${path}: "permissions.allow" must be an array.`);
  }
  if (value.hooks !== undefined && (typeof value.hooks !== "object" || value.hooks === null || Array.isArray(value.hooks))) {
    throw new ZError(`${path}: "hooks" must be an object.`);
  }
  if (value.hooks?.PermissionRequest !== undefined && !Array.isArray(value.hooks.PermissionRequest)) {
    throw new ZError(`${path}: "hooks.PermissionRequest" must be an array.`);
  }
}

// Writes go through lib/cli.ts atomicWrite (tmp + rename, mode 0o600): a reader
// never observes a half-written settings.json, and a file that can carry
// blanket auto-approval is never briefly world-readable.

// Implementation note from the live incident (issue #12 point 5): a running
// Claude Code session persists its in-memory permission state back to
// settings.json on every approval event, and can clobber our write if one
// lands between our rename() and this read. Re-reading and comparing to what
// we intended to write is the only way to know our write actually stuck.
export function verifyWrite(path: string, expected: string): void {
  const onDisk = readFileSync(path, "utf8");
  if (onDisk !== expected) {
    throw new ZError(
      `${path} changed on disk between write and verification -- a running Claude Code session ` +
        `likely persisted its own settings write concurrently. Re-run to retry.`
    );
  }
}

export interface ApplyResult {
  path: string;
  changed: boolean;
  changes: string[];
}

// Read -> merge -> (JSON-validate "after") -> atomic write -> re-read to
// verify. A no-op merge never touches disk at all (idempotence criterion 3:
// re-run with everything configured reports zero changes).
export function applySettings(path: string, mode: PermissionsMode): ApplyResult {
  const input = readSettingsFile(path);
  const { settings, changed, changes } = mergeSettings(input, mode);
  if (!changed) return { path, changed: false, changes: [] };

  const serialized = JSON.stringify(settings, null, 2) + "\n";
  try {
    JSON.parse(serialized);
  } catch (e) {
    // Only reachable if this file's own merge produced unserializable output --
    // a bug here, not a user error, but still named loudly rather than a raw
    // write of garbage.
    throw new ZError(`Internal error: merged settings for ${path} failed to validate as JSON: ${(e as Error).message}`);
  }

  atomicWrite(path, serialized);
  verifyWrite(path, serialized);
  return { path, changed: true, changes };
}

// Read -> remove (the inverse merge) -> atomic write -> re-read to verify, the
// same pipeline as applySettings. A file carrying none of our entries is a no-op
// that never touches disk (removal idempotence: a second `--remove` is zero-diff).
export function applyRemove(path: string): ApplyResult {
  const input = readSettingsFile(path);
  const { settings, changed, changes } = removeSettings(input);
  if (!changed) return { path, changed: false, changes: [] };

  const serialized = JSON.stringify(settings, null, 2) + "\n";
  try {
    JSON.parse(serialized);
  } catch (e) {
    throw new ZError(`Internal error: settings for ${path} failed to validate as JSON after removal: ${(e as Error).message}`);
  }

  atomicWrite(path, serialized);
  verifyWrite(path, serialized);
  return { path, changed: true, changes };
}

export function checkSettings(path: string): CheckReport {
  return checkLayers(readSettingsFile(path));
}

// -- CLI -----------------------------------------------------------------------
const USAGE = `z-setup-permissions <full|allowlist|--check|--remove> [--path PATH]

  full       merge the PermissionRequest allow hook + bypassPermissions +
             skip flags + the allow rules into PATH (grants everything via the
             hook regardless of the allow list)
  allowlist  merge ONLY the specific allow rules (git/gh/bun/bunx); no hook, no
             defaultMode/skip-flag changes, no bash/claude/Edit/Write blanket
  --check    report each of the three layers (hook, bypassMode, allowlist)
             independently present/absent; makes no changes
  --remove   strip EXACTLY the entries the full/allowlist path writes -- the
             allow rules, the bypass keys, and our PermissionRequest hook --
             leaving every other setting intact (the /z-uninstall undo)

PATH defaults to ~/.claude/settings.json. Read-modify-write merge: every
existing key and rule is preserved. Re-running once everything is configured
(or once nothing of ours remains, for --remove) makes zero changes and says so.`;

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export async function main(argv: string[]): Promise<number> {
  let cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === "--check") cmd = "check";
  if (cmd === "--remove") cmd = "remove";
  if (!["full", "allowlist", "check", "remove"].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }

  try {
    const { flags } = parseFlags(argv.slice(1));
    const path = str(flags, "path") ?? defaultSettingsPath();

    if (cmd === "check") {
      const report = checkSettings(path);
      for (const [name, layer] of Object.entries(report)) {
        console.log(`${name}: ${layer.present ? "PRESENT" : "ABSENT"} -- ${layer.detail}`);
      }
      const ok = report.hook.present && report.bypassMode.present && report.allowlist.present;
      return ok ? 0 : 1;
    }

    if (cmd === "remove") {
      const result = applyRemove(path);
      if (!result.changed) {
        console.log(`${path} carries none of zstack's permission entries; zero changes.`);
        return 0;
      }
      console.log(`Removed ${result.changes.length} zstack entr${result.changes.length === 1 ? "y" : "ies"} from ${path}:`);
      for (const c of result.changes) console.log(`  ${c}`);
      return 0;
    }

    const result = applySettings(path, cmd as PermissionsMode);
    if (!result.changed) {
      console.log(`${path} already matches "${cmd}"; zero changes.`);
      return 0;
    }
    console.log(`Applied ${result.changes.length} change(s) to ${path}:`);
    for (const c of result.changes) console.log(`  ${c}`);
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
