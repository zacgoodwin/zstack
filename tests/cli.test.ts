// Gate tests for lib/cli.ts's parseFlags (issue #156). Two drifts fixed here:
// `--flag=value` used to be silently misparsed as a single boolean-ish key
// (the whole "--slug=foo" token, minus "--", landed in flags as a truthy
// key with no value), and a trailing value-flag (the flag is the last argv
// token, so there is no following token to consume) stored `undefined`
// instead of erroring -- a caller reading it via `str()`/`requireFlag` saw
// "flag missing", not "flag malformed", masking a typo'd command line.
//
// A third drift (caught in adversarial review): the initial `--flag=value`
// fix assigned the raw string BEFORE checking `booleans.includes(key)`, so
// a boolean flag parsed differently depending on which syntax the caller
// used (`--json` -> true, `--json=true` -> the STRING "true"). Real callers
// (lib/cost.ts:520 `flags.json === true`, lib/locks.ts:507
// `flags.reconcile === true`) strictly compare against the boolean, so the
// `=` form silently defeated them. The tests below cross both syntaxes with
// both values for a boolean-listed key, plus the invalid-value case.
import { test, expect, describe } from "bun:test";
import { parseFlags } from "../lib/cli.ts";
import { ZError } from "../lib/config.ts";

describe("parseFlags", () => {
  test("space-separated --flag value pairs plus positionals (baseline)", () => {
    const { positionals, flags } = parseFlags(["build", "--slug", "zstack", "--title", "My Project"]);
    expect(positionals).toEqual(["build"]);
    expect(flags).toEqual({ slug: "zstack", title: "My Project" });
  });

  test("a boolean flag (listed in `booleans`) consumes no value and stores true", () => {
    const { positionals, flags } = parseFlags(["--json", "--slug", "zstack"], ["json"]);
    expect(positionals).toEqual([]);
    expect(flags).toEqual({ json: true, slug: "zstack" });
  });

  // AC: "--slug=foo" parses to { slug: "foo" }.
  test("--flag=value parses the same as --flag value", () => {
    const { flags } = parseFlags(["--slug=foo"]);
    expect(flags).toEqual({ slug: "foo" });
  });

  test("--flag=value survives a value that itself contains '=' (split on the FIRST '=' only)", () => {
    const { flags } = parseFlags(["--title=a=b=c"]);
    expect(flags).toEqual({ title: "a=b=c" });
  });

  test("--flag= (empty value after the equals) parses to an empty string, not undefined", () => {
    const { flags } = parseFlags(["--slug="]);
    expect(flags).toEqual({ slug: "" });
  });

  test("--flag=value mixed with space-separated flags and positionals in one call", () => {
    const { positionals, flags } = parseFlags(["apply", "--slug=zstack", "--title", "My Project", "--force"], ["force"]);
    expect(positionals).toEqual(["apply"]);
    expect(flags).toEqual({ slug: "zstack", title: "My Project", force: true });
  });

  // AC: a trailing "--slug" with no value is a loud usage error, not a
  // silent `flags.slug === undefined`.
  test("a trailing value-flag with no following token throws a loud ZError", () => {
    expect(() => parseFlags(["--slug"])).toThrow(ZError);
    expect(() => parseFlags(["--slug"])).toThrow(/--slug/);
  });

  test("a value-flag as the last of several tokens still throws (not just when it's the only token)", () => {
    expect(() => parseFlags(["--title", "My Project", "--slug"])).toThrow(/--slug/);
  });

  test("a boolean flag as the very last token is unaffected (no value to consume, no error)", () => {
    const { flags } = parseFlags(["--slug", "zstack", "--force"], ["force"]);
    expect(flags).toEqual({ slug: "zstack", force: true });
  });

  // Regression for the reintroduced bug: a boolean-listed key must coerce to
  // a real boolean under BOTH spellings, so `flags.json === true` behaves
  // identically regardless of which syntax the caller typed.
  test("--flag=true on a boolean-listed key parses to the boolean true, not the string \"true\"", () => {
    const { flags } = parseFlags(["--json=true"], ["json"]);
    expect(flags.json).toBe(true);
    expect(flags.json === true).toBe(true);
  });

  test("--flag=false on a boolean-listed key parses to the boolean false, not the string \"false\"", () => {
    const { flags } = parseFlags(["--json=false"], ["json"]);
    expect(flags.json).toBe(false);
    expect(flags.json === true).toBe(false);
  });

  test("space form and =true form agree for the same boolean-listed key", () => {
    const spaceForm = parseFlags(["--json"], ["json"]);
    const eqForm = parseFlags(["--json=true"], ["json"]);
    expect(spaceForm.flags.json).toBe(eqForm.flags.json);
    expect(eqForm.flags.json).toBe(true);
  });

  test("--flag=maybe on a boolean-listed key throws a loud ZError instead of storing a truthy string", () => {
    expect(() => parseFlags(["--json=maybe"], ["json"])).toThrow(ZError);
    expect(() => parseFlags(["--json=maybe"], ["json"])).toThrow(/--json/);
  });

  test("--flag=value on a non-boolean key is unaffected by the boolean coercion path", () => {
    const { flags } = parseFlags(["--slug=true"]);
    expect(flags).toEqual({ slug: "true" });
  });
});
