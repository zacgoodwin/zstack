// Gate tests for C11: the /z-setup auto-approvals step (lib/setup-permissions.ts).
// Every test copies a fixture into a throwaway temp dir before touching it --
// applySettings() writes in place, and the checked-in fixtures under
// tests/fixtures/settings/ must stay pristine across runs. No test ever
// passes a path derived from homedir(): acceptance criterion 4 (no test
// touches the real ~/.claude/settings.json) is structural, not a convention.
import { test, expect, describe, afterEach } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOW_RULES,
  PERMISSION_REQUEST_HOOK_COMMAND,
  applySettings,
  checkSettings,
  hasBypassMode,
  hasPermissionRequestAllowHook,
  mergeSettings,
  missingAllowRules,
  readSettingsFile,
  verifyWrite,
  type PermissionsMode,
} from "../lib/setup-permissions.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "settings");

// -- helpers -------------------------------------------------------------
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zstack-perms-"));
  dirs.push(dir);
  return dir;
}

// Copies a fixture into a fresh temp dir and returns the writable path, so
// applySettings can mutate it without touching the checked-in fixture.
function tempPath(fixture: string): string {
  const dir = makeDir();
  const path = join(dir, "settings.json");
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// -- mergeSettings (pure, no fs) -------------------------------------------
describe("mergeSettings", () => {
  test("empty input + full: adds all three layers (12 changes)", () => {
    const { settings, changed, changes } = mergeSettings({}, "full");
    expect(changed).toBe(true);
    expect(changes).toHaveLength(ALLOW_RULES.length + 3 + 1); // 8 allow + defaultMode + 2 skip flags + hook
    expect(settings.permissions.allow).toEqual([...ALLOW_RULES]);
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.skipAutoPermissionPrompt).toBe(true);
    expect(hasPermissionRequestAllowHook(settings)).toBe(true);
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toBe(PERMISSION_REQUEST_HOOK_COMMAND);
  });

  test("empty input + allowlist: adds only the allow rules, no hook, no mode change", () => {
    const { settings, changed, changes } = mergeSettings({}, "allowlist");
    expect(changed).toBe(true);
    expect(changes).toHaveLength(ALLOW_RULES.length);
    expect(settings.permissions.allow).toEqual([...ALLOW_RULES]);
    expect(settings.permissions.defaultMode).toBeUndefined();
    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(settings.hooks).toBeUndefined();
  });

  test("a fully-configured object plans zero changes in full mode (idempotence)", () => {
    const full = readJson(join(FIXTURES, "fully-configured.json"));
    const { changed, changes } = mergeSettings(full, "full");
    expect(changed).toBe(false);
    expect(changes).toEqual([]);
  });

  test("feeding a merge's own output back in reports zero changes", () => {
    const first = mergeSettings({ model: "x" }, "full");
    const second = mergeSettings(first.settings, "full");
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
  });

  test("existing custom rules and unrelated top-level keys survive the merge untouched", () => {
    const existing = readJson(join(FIXTURES, "existing-rules.json"));
    const { settings } = mergeSettings(existing, "full");
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Bash(git add *)", "Bash(npm install *)", "Read(//c/Users/zacgo/.claude/**)"]));
    expect(settings.permissions.additionalDirectories).toEqual(["C:\\Users\\zacgo\\.claude"]);
    expect(settings.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    expect(settings.model).toBe("claude-fable-5[1m]");
    expect(settings.effortLevel).toBe("xhigh");
    // ...plus the new layers.
    expect(missingAllowRules(settings)).toEqual([]);
    expect(hasBypassMode(settings)).toBe(true);
  });

  test("an existing PermissionRequest hook that already answers allow is not duplicated", () => {
    const input = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: 'echo \'{"permissionDecision":"allow","permissionDecisionReason":"some other wording"}\'' }] },
        ],
      },
    };
    const { settings, changes } = mergeSettings(input, "full");
    expect(settings.hooks.PermissionRequest).toHaveLength(1); // not duplicated
    expect(changes.some((c) => c.includes("hooks.PermissionRequest"))).toBe(false);
  });

  test("an existing PermissionRequest hook that denies does not block ours from being added", () => {
    const input = {
      hooks: {
        PermissionRequest: [{ hooks: [{ type: "command", command: 'echo \'{"permissionDecision":"deny"}\'' }] }],
      },
    };
    const { settings, changes } = mergeSettings(input, "full");
    expect(settings.hooks.PermissionRequest).toHaveLength(2); // theirs + ours
    expect(changes.some((c) => c.includes("hooks.PermissionRequest"))).toBe(true);
  });
});

// -- applySettings (fs: read-modify-write, atomic, verified) ---------------
describe("applySettings", () => {
  test("empty fixture + full: writes all three layers", () => {
    const path = tempPath("empty.json");
    const result = applySettings(path, "full");
    expect(result.changed).toBe(true);
    expect(result.path).toBe(path);
    const onDisk = readJson(path);
    expect(missingAllowRules(onDisk)).toEqual([]);
    expect(hasBypassMode(onDisk)).toBe(true);
    expect(hasPermissionRequestAllowHook(onDisk)).toBe(true);
  });

  test("a path that does not exist yet bootstraps identically to an empty file", () => {
    const dir = makeDir();
    const path = join(dir, "settings.json"); // never created
    const result = applySettings(path, "allowlist");
    expect(result.changed).toBe(true);
    expect(missingAllowRules(readJson(path))).toEqual([]);
  });

  test("existing-rules fixture + full: preserves everything, adds the new layers, ends valid JSON", () => {
    const path = tempPath("existing-rules.json");
    const before = readJson(path);
    const result = applySettings(path, "full");
    expect(result.changed).toBe(true);

    const after = readJson(path);
    expect(after.permissions.allow).toEqual(expect.arrayContaining(before.permissions.allow));
    expect(after.hooks.SessionStart).toEqual(before.hooks.SessionStart);
    expect(after.model).toBe(before.model);
    expect(missingAllowRules(after)).toEqual([]);
    expect(hasBypassMode(after)).toBe(true);
    expect(hasPermissionRequestAllowHook(after)).toBe(true);
  });

  test("already-fully-configured fixture + full: zero-diff, file left byte-identical, reports it", () => {
    const path = tempPath("fully-configured.json");
    const before = readFileSync(path, "utf8");
    const result = applySettings(path, "full");
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before); // no write happened at all
  });

  test("allowlist-configured fixture + allowlist: zero-diff", () => {
    const path = tempPath("allowlist-configured.json");
    const before = readFileSync(path, "utf8");
    const result = applySettings(path, "allowlist");
    expect(result.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("allowlist-configured fixture + full: still adds hook + bypassMode (allowlist alone isn't full)", () => {
    const path = tempPath("allowlist-configured.json");
    const result = applySettings(path, "full");
    expect(result.changed).toBe(true);
    const after = readJson(path);
    expect(hasBypassMode(after)).toBe(true);
    expect(hasPermissionRequestAllowHook(after)).toBe(true);
  });

  test("re-running full after full reports zero changes (idempotence, end-to-end)", () => {
    const path = tempPath("empty.json");
    applySettings(path, "full");
    const second = applySettings(path, "full");
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
  });

  test("malformed JSON: loud error naming the file, and no write occurs", () => {
    const path = tempPath("malformed.json");
    const before = readFileSync(path, "utf8");
    expect(() => applySettings(path, "full")).toThrow(path);
    expect(() => applySettings(path, "full")).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe(before); // untouched
    // No stray tmp file left in the directory either.
    const dir = join(path, "..");
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("a settings root that is an array is rejected loudly, naming the file", () => {
    const dir = makeDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, "[]");
    expect(() => applySettings(path, "full")).toThrow(path);
    expect(() => applySettings(path, "full")).toThrow(/must contain a JSON object/);
  });
});

// -- checkSettings / checkLayers (--check mode) ----------------------------
describe("checkSettings", () => {
  test("empty settings: all three layers report absent", () => {
    const report = checkSettings(tempPath("empty.json"));
    expect(report.hook.present).toBe(false);
    expect(report.bypassMode.present).toBe(false);
    expect(report.allowlist.present).toBe(false);
    expect(report.allowlist.detail).toContain("Bash(git *)");
  });

  test("fully-configured settings: all three layers report present, independently", () => {
    const report = checkSettings(tempPath("fully-configured.json"));
    expect(report.hook.present).toBe(true);
    expect(report.bypassMode.present).toBe(true);
    expect(report.allowlist.present).toBe(true);
  });

  test("allowlist-only settings: allowlist present, hook and bypassMode absent", () => {
    const report = checkSettings(tempPath("allowlist-configured.json"));
    expect(report.allowlist.present).toBe(true);
    expect(report.hook.present).toBe(false);
    expect(report.bypassMode.present).toBe(false);
  });

  test("malformed JSON surfaces the same loud, named error on --check", () => {
    const path = tempPath("malformed.json");
    expect(() => checkSettings(path)).toThrow(path);
  });
});

// -- verifyWrite (the re-read-to-verify half of the atomic write) ---------
describe("verifyWrite", () => {
  test("passes when the file on disk matches what was written", () => {
    const dir = makeDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"a":1}');
    expect(() => verifyWrite(path, '{"a":1}')).not.toThrow();
  });

  test("throws when the file on disk no longer matches (simulated concurrent clobber)", () => {
    const dir = makeDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"a":1}');
    // Simulate another process (a running Claude Code session) overwriting the
    // file between our rename() and our re-read.
    writeFileSync(path, '{"a":2}');
    expect(() => verifyWrite(path, '{"a":1}')).toThrow(/changed on disk/);
  });
});

// -- readSettingsFile (bootstrap + validation surface) ---------------------
describe("readSettingsFile", () => {
  test("a nonexistent path reads as an empty object", () => {
    const dir = makeDir();
    expect(readSettingsFile(join(dir, "nope.json"))).toEqual({});
  });

  test("a whitespace-only file reads as an empty object", () => {
    const dir = makeDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, "   \n");
    expect(readSettingsFile(path)).toEqual({});
  });

  test("permissions.allow that is not an array is rejected, naming the file", () => {
    const dir = makeDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { allow: "oops" } }));
    expect(() => readSettingsFile(path)).toThrow(path);
    expect(() => readSettingsFile(path)).toThrow(/permissions\.allow/);
  });
});

// -- sanity: the exact modes exercised match the spec's contract -----------
test("PermissionsMode is exactly full | allowlist", () => {
  const modes: PermissionsMode[] = ["full", "allowlist"];
  expect(modes).toEqual(["full", "allowlist"]);
});
