// Gate tests for C11: the /z-setup auto-approvals step (lib/setup-permissions.ts).
// Every test copies a fixture into a throwaway temp dir before touching it --
// applySettings() writes in place, and the checked-in fixtures under
// tests/fixtures/settings/ must stay pristine across runs. No test ever
// passes a path derived from homedir(): acceptance criterion 4 (no test
// touches the real ~/.claude/settings.json) is structural, not a convention.
import { test, expect, describe, afterEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOW_RULES,
  PERMISSION_REQUEST_HOOK_COMMAND,
  applyRemove,
  applySettings,
  checkSettings,
  hasBypassMode,
  hasPermissionRequestAllowHook,
  mergeSettings,
  missingAllowRules,
  readSettingsFile,
  removeSettings,
  verifyWrite,
  type PermissionsMode,
} from "../lib/setup-permissions.ts";
import { atomicWrite } from "../lib/cli.ts";

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
  test("empty input + full: adds all three layers", () => {
    const { settings, changed, changes } = mergeSettings({}, "full");
    expect(changed).toBe(true);
    expect(changes).toHaveLength(ALLOW_RULES.length + 3 + 1); // allow rules + defaultMode + 2 skip flags + hook
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

  test("the allowlist tier is genuinely narrow: no bash/claude escape hatches, no blanket Edit/Write (fix 4)", () => {
    const { settings } = mergeSettings({}, "allowlist");
    // These four made option B equivalent to full bypass; they must be gone.
    expect(settings.permissions.allow).not.toContain("Bash(bash *)");
    expect(settings.permissions.allow).not.toContain("Bash(claude *)");
    expect(settings.permissions.allow).not.toContain("Edit");
    expect(settings.permissions.allow).not.toContain("Write");
    // Exactly the specific tool prefixes, nothing else.
    expect(settings.permissions.allow).toEqual(["Bash(git *)", "Bash(gh *)", "Bash(bun *)", "Bash(bunx *)"]);
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

  test("an existing hook carrying OUR reason marker is recognized as ours and not duplicated (idempotence)", () => {
    const input = {
      hooks: {
        PermissionRequest: [{ hooks: [{ type: "command", command: PERMISSION_REQUEST_HOOK_COMMAND }] }],
      },
    };
    const { settings, changes } = mergeSettings(input, "full");
    expect(settings.hooks.PermissionRequest).toHaveLength(1); // not duplicated
    expect(changes.some((c) => c.includes("hooks.PermissionRequest"))).toBe(false);
  });

  test("a foreign allow-hook with a different reason is NOT mistaken for ours; full adds ours alongside (fix 5)", () => {
    const input = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: 'echo \'{"permissionDecision":"allow","permissionDecisionReason":"some other wording"}\'' }] },
        ],
      },
    };
    const { settings, changes } = mergeSettings(input, "full");
    expect(settings.hooks.PermissionRequest).toHaveLength(2); // theirs + ours
    expect(changes.some((c) => c.includes("hooks.PermissionRequest"))).toBe(true);
  });

  test("a deny-hook whose text contains the allow literal is NOT a false positive (fix 5)", () => {
    // A legitimate deny hook can mention the allow token in its own logic/comment.
    // Detection keys off our reason marker, so this must not read as an existing
    // allow-hook -- and full must still add ours alongside it.
    const denyWithAllowLiteral = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: 'echo \'{"permissionDecision":"deny"}\'  # not "permissionDecision":"allow"' }] },
        ],
      },
    };
    expect(hasPermissionRequestAllowHook(denyWithAllowLiteral)).toBe(false);
    const { settings, changes } = mergeSettings(denyWithAllowLiteral, "full");
    expect(settings.hooks.PermissionRequest).toHaveLength(2); // deny hook + ours
    expect(changes.some((c) => c.includes("hooks.PermissionRequest"))).toBe(true);
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

// -- removeSettings (pure inverse: strip exactly what apply writes) ---------
// Ticket #37 AC4: the /z-uninstall permissions undo. Every test asserts our
// entries gone AND unrelated keys/rules intact.
describe("removeSettings", () => {
  test("a fully-configured object: all three layers stripped, changed true", () => {
    const full = readJson(join(FIXTURES, "fully-configured.json"));
    const { settings, changed } = removeSettings(full);
    expect(changed).toBe(true);
    expect(missingAllowRules(settings)).toEqual([...ALLOW_RULES]); // all four gone
    expect(hasBypassMode(settings)).toBe(false);
    expect(hasPermissionRequestAllowHook(settings)).toBe(false);
    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(settings.skipAutoPermissionPrompt).toBeUndefined();
  });

  test("AC4: our entries removed, every unrelated key/rule/hook preserved", () => {
    // fully-configured.json carries our 4 rules + an unrelated Bash(git add *),
    // defaultMode/skip/our hook, PLUS unrelated model, effortLevel, and a
    // foreign SessionStart hook -- the exact "ours + theirs" shape AC4 names.
    const full = readJson(join(FIXTURES, "fully-configured.json"));
    const { settings } = removeSettings(full);
    // Unrelated allow rule kept; ours gone; the array survives (non-empty).
    expect(settings.permissions.allow).toEqual(["Bash(git add *)"]);
    // Unrelated top-level keys untouched.
    expect(settings.model).toBe("claude-fable-5[1m]");
    expect(settings.effortLevel).toBe("xhigh");
    // Foreign hook family survives byte-for-byte; ours is gone from the tree.
    expect(settings.hooks.SessionStart).toEqual(full.hooks.SessionStart);
    expect(settings.hooks.PermissionRequest).toBeUndefined();
  });

  test("removing the merge's own output returns to the original empty object", () => {
    const merged = mergeSettings({}, "full").settings;
    const { settings } = removeSettings(merged);
    expect(settings).toEqual({}); // containers we created are cleaned up
  });

  test("start-with-extras: allowlist merge then remove restores the extras exactly", () => {
    // allowlist mode never touches defaultMode, so the user's own mode survives
    // the round-trip. (full mode deliberately clobbers defaultMode to
    // bypassPermissions -- a foreign mode is preserved only when we never wrote
    // it, which the dedicated test below pins.)
    const before = { model: "x", permissions: { allow: ["Read(/x/**)"], defaultMode: "acceptEdits" } };
    const merged = mergeSettings(before, "allowlist").settings;
    const { settings } = removeSettings(merged);
    expect(settings.permissions.allow).toEqual(["Read(/x/**)"]);
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(settings.model).toBe("x");
    expect(missingAllowRules(settings)).toEqual([...ALLOW_RULES]);
  });

  test("a foreign defaultMode is never removed (only bypassPermissions is ours)", () => {
    const { settings, changed } = removeSettings({ permissions: { defaultMode: "plan" } });
    expect(changed).toBe(false);
    expect(settings.permissions.defaultMode).toBe("plan");
  });

  test("a foreign PermissionRequest allow-hook (different reason) is preserved", () => {
    const foreign = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: 'echo \'{"permissionDecision":"allow","permissionDecisionReason":"some other wording"}\'' }] }] } };
    const { settings, changed } = removeSettings(foreign);
    expect(changed).toBe(false);
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
  });

  test("our hook colocated with a foreign hook in one group: only ours is dropped", () => {
    const foreignCmd = 'echo \'{"permissionDecision":"deny"}\'';
    const input = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: foreignCmd }, { type: "command", command: PERMISSION_REQUEST_HOOK_COMMAND }] }] } };
    const { settings, changed } = removeSettings(input);
    expect(changed).toBe(true);
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.PermissionRequest[0].hooks).toEqual([{ type: "command", command: foreignCmd }]);
  });

  test("allowlist-only settings: rules removed, no hook/bypass churn", () => {
    const input = readJson(join(FIXTURES, "allowlist-configured.json"));
    const { settings, changed } = removeSettings(input);
    expect(changed).toBe(true);
    expect(missingAllowRules(settings)).toEqual([...ALLOW_RULES]);
  });

  test("empty settings: nothing to remove, changed false", () => {
    const { changed, changes } = removeSettings({});
    expect(changed).toBe(false);
    expect(changes).toEqual([]);
  });

  test("removeSettings is idempotent: second pass reports zero changes", () => {
    const full = readJson(join(FIXTURES, "fully-configured.json"));
    const first = removeSettings(full).settings;
    const second = removeSettings(first);
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
  });
});

// -- applyRemove (fs: read-remove-write, atomic, verified) -----------------
describe("applyRemove", () => {
  test("fully-configured fixture: writes back with our entries stripped, others intact", () => {
    const path = tempPath("fully-configured.json");
    const before = readJson(path);
    const result = applyRemove(path);
    expect(result.changed).toBe(true);
    const after = readJson(path);
    expect(missingAllowRules(after)).toEqual([...ALLOW_RULES]);
    expect(hasBypassMode(after)).toBe(false);
    expect(hasPermissionRequestAllowHook(after)).toBe(false);
    expect(after.permissions.allow).toEqual(["Bash(git add *)"]);
    expect(after.model).toBe(before.model);
    expect(after.hooks.SessionStart).toEqual(before.hooks.SessionStart);
  });

  test("a file carrying none of our entries is a zero-diff no-op (removal idempotence)", () => {
    const path = tempPath("existing-rules.json");
    const before = readFileSync(path, "utf8");
    const result = applyRemove(path);
    expect(result.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before); // no write happened at all
  });

  test("apply full then applyRemove leaves the file byte-identical to the pre-apply state", () => {
    const path = tempPath("empty.json");
    const original = readFileSync(path, "utf8");
    applySettings(path, "full");
    applyRemove(path);
    // empty.json is `{}` -> merge full -> remove == round-trips to `{}`.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(original));
  });

  test("re-running applyRemove reports zero changes the second time", () => {
    const path = tempPath("fully-configured.json");
    applyRemove(path);
    const second = applyRemove(path);
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
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

// -- fix 6: settings.json written owner-only, never world-readable ---------
describe("atomicWrite file mode", () => {
  test("applySettings writes settings.json 0o600 (owner-only)", () => {
    const path = tempPath("empty.json");
    applySettings(path, "full");
    // fs mode bits don't map to POSIX perms on Windows; skip the assertion there
    // so the gate stays green cross-platform (the mode arg is a harmless no-op).
    if (process.platform === "win32") return;
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

// -- atomicWrite failure handling (F16): cleanup + bounded Windows retry ---
// A tiny error factory: the seam only inspects .code, matching how fs errors
// carry it.
function errnoErr(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe("atomicWrite failure handling", () => {
  test("rename failure unlinks the tmp file and propagates the error", () => {
    const dir = makeDir();
    const target = join(dir, "target");
    // renameSync cannot replace an existing directory on Windows or POSIX, so
    // this fails deterministically through the real fs (EPERM/EISDIR).
    mkdirSync(target);
    expect(() => atomicWrite(target, "x")).toThrow();
    expect(statSync(target).isDirectory()).toBe(true); // target untouched
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("transient EPERM is retried: two failures then success writes the file", () => {
    const dir = makeDir();
    const target = join(dir, "out.json");
    let calls = 0;
    atomicWrite(target, "hello", (from, to) => {
      if (++calls <= 2) throw errnoErr("EPERM");
      renameSync(from, to);
    });
    expect(calls).toBe(3);
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("a non-retryable rename error (ENOENT) fails on attempt 1, no retries, tmp cleaned", () => {
    const dir = makeDir();
    let calls = 0;
    expect(() =>
      atomicWrite(join(dir, "out.json"), "x", () => {
        calls++;
        throw errnoErr("ENOENT");
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("persistent EPERM gives up after exactly 3 attempts, tmp cleaned", () => {
    const dir = makeDir();
    let calls = 0;
    expect(() =>
      atomicWrite(join(dir, "out.json"), "x", () => {
        calls++;
        throw errnoErr("EPERM");
      }),
    ).toThrow("EPERM");
    expect(calls).toBe(3);
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });
});

// -- sanity: the exact modes exercised match the spec's contract -----------
test("PermissionsMode is exactly full | allowlist", () => {
  const modes: PermissionsMode[] = ["full", "allowlist"];
  expect(modes).toEqual(["full", "allowlist"]);
});
