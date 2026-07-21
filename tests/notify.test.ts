// Gate tests for #60: the notifications edge. Deterministic, <2s, zero network
// -- a Poster spy replaces the real fetch (exactly as tests/board.test.ts injects
// a fake GraphQLExecutor). renderNotification is pure so it is asserted
// substring-exact and byte-identical; notify() is exercised through every
// degradation branch; the webhook URL (a secret) is asserted to never reach a log
// line or a rendered message; and config-schema's notifications branch is checked
// good-and-bad, including that a bad value never leaks into the error.
//
// No eval suite (AC9): the seven messages are fully templated and deterministic --
// there is no latent/LLM step and no quality dimension to measure -- so per
// CLAUDE.md's latent-vs-deterministic split these gate tests are the complete
// verification. A future free-text notification (e.g. an LLM-summarized digest)
// would add an evals/ runbook; this ticket ships none and says so.
import { test, expect, describe, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  notify,
  renderNotification,
  EVENT_KEYS,
  type Poster,
  type PayloadByEvent,
} from "../lib/notify.ts";
import { loadConfig, ZError, type BoardConfig } from "../lib/config.ts";
import { validateConfig } from "../lib/config-schema.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123/abcSECRETtoken";

// A full, valid board config (mirrors tests/board.test.ts) so the notifications
// block round-trips through validateConfig + loadConfig on top of a real config.
const BASE_CFG: BoardConfig = {
  slug: "zstack",
  owner: "zacgoodwin",
  repo: "zstack",
  projectNumber: 1,
  projectId: "PVT_1",
  repositoryId: "R_1",
  statusField: {
    id: "F_status",
    dataType: "SINGLE_SELECT",
    options: { Todo: "opt_todo", Done: "opt_done" },
  },
  fields: {
    Model: { id: "F_model", dataType: "SINGLE_SELECT", options: { opus: "opt_opus" } },
    Estimate: { id: "F_est", dataType: "NUMBER" },
  },
};

function cfgWith(notifications: BoardConfig["notifications"]): BoardConfig {
  return { ...BASE_CFG, notifications };
}

// A capturing Poster spy: records every (url, body) it was called with.
function spyPoster(): { post: Poster; calls: { url: string; body: { content: string } }[] } {
  const calls: { url: string; body: { content: string } }[] = [];
  const post: Poster = async (url, body) => {
    calls.push({ url, body });
  };
  return { post, calls };
}

const WC: PayloadByEvent["work-complete"] = {
  slug: "zstack",
  loopCount: 7,
  done: 3,
  questions: 2,
  blocked: 1,
  skipped: 0,
  totalDollars: 12.5,
  verdict: "green",
};
const PLAN: PayloadByEvent["plan-complete"] = { slug: "zstack", ticketsCreated: 4 };
const PARK: PayloadByEvent["ticket-parked"] = {
  ticket: 42,
  title: "Notifications Feature",
  status: "Blocked",
  note: "stage-blocked: build failed",
};
const PAUSE: PayloadByEvent["human-pause"] = { ticket: 9, title: "Auth flow", note: "which OAuth provider?" };
const HUMAN_NEEDED: PayloadByEvent["human-needed"] = {
  tripped: true,
  alreadyNotified: false,
  blocked: 2,
  skipped: 1,
  questions: 1,
  initialReadyCount: 10,
  percent: 30,
  tickets: { blocked: [1, 2], skipped: [3], questions: [4] },
};

// -- renderNotification (pure) -----------------------------------------------
describe("renderNotification", () => {
  test("work-complete formats counts + dollars", () => {
    const s = renderNotification("work-complete", WC);
    expect(s).toContain("done 3");
    expect(s).toContain("blocked 1");
    expect(s).toContain("$12.50");
    expect(s).toContain("regression green");
  });

  // AC1 + AC2 (#68): a plan run and a loop drain must read as distinct events
  // -- the plan template never says "loop N" and the loop template is
  // untouched by the new event's existence.
  test("render: plan completion names the plan run", () => {
    const s = renderNotification("plan-complete", PLAN);
    expect(s).toContain("plan run");
    expect(s).toContain("4 tickets");
    expect(s).not.toContain("loop 0");
    expect(s).not.toMatch(/\bloop\b/i);
  });

  test("render: loop work-complete unchanged", () => {
    const loop3: PayloadByEvent["work-complete"] = { ...WC, loopCount: 3 };
    expect(renderNotification("work-complete", loop3)).toBe(
      "zstack zstack: loop 3 complete. done 3, questions 2, blocked 1, skipped 0. spend $12.50. regression green."
    );
  });

  test("ticket-parked formats #, title, status, note", () => {
    const s = renderNotification("ticket-parked", PARK);
    expect(s).toContain("#42");
    expect(s).toContain("Notifications Feature");
    expect(s).toContain("→ Blocked");
    expect(s).toContain("stage-blocked: build failed");
  });

  test("human-pause / safety-violation / token-burn templates", () => {
    expect(renderNotification("human-pause", PAUSE)).toContain("needs input on #9 Auth flow");
    expect(
      renderNotification("safety-violation", { control: "watchdog", ticket: 5, detail: "wedged/dead worker" })
    ).toContain('safety control "watchdog" tripped on #5');
    // safety-violation without a ticket omits the "on #N" fragment.
    expect(
      renderNotification("safety-violation", { control: "quota", detail: "GraphQL quota exhausted" })
    ).toBe('zstack: safety control "quota" tripped. GraphQL quota exhausted');
    expect(renderNotification("token-burn", { detail: "dependency deadlock", ticket: 8 })).toContain(
      "token-burn guard on #8"
    );
  });

  test("human-needed formats the parked-tickets breakdown (issue #63)", () => {
    const s = renderNotification("human-needed", HUMAN_NEEDED);
    expect(s).toContain("4/10 parked"); // 2 blocked + 1 skipped + 1 questions
    expect(s).toContain("> 30%");
    expect(s).toContain("Blocked #1, #2");
    expect(s).toContain("Skipped #3");
    expect(s).toContain("Questions #4");
  });

  test("human-needed lists 'none' for an empty parked category", () => {
    const s = renderNotification("human-needed", { ...HUMAN_NEEDED, skipped: 0, tickets: { ...HUMAN_NEEDED.tickets, skipped: [] } });
    expect(s).toContain("Skipped none");
  });

  test("identical input is byte-identical (deterministic)", () => {
    expect(renderNotification("work-complete", WC)).toBe(renderNotification("work-complete", WC));
    expect(renderNotification("ticket-parked", PARK)).toBe(renderNotification("ticket-parked", PARK));
  });

  test("truncates to Discord's 2000-char content limit", () => {
    const s = renderNotification("ticket-parked", { ...PARK, note: "x".repeat(5000) });
    expect(s.length).toBe(2000);
  });
});

// -- notify (side-effecting edge) --------------------------------------------
describe("notify", () => {
  afterEach(() => {
    delete process.env.ZSTACK_DISCORD_WEBHOOK;
  });

  test("no-op when notifications block absent (AC2)", async () => {
    delete process.env.ZSTACK_DISCORD_WEBHOOK;
    const { post, calls } = spyPoster();
    const ok = await notify("work-complete", WC, cfgWith(undefined), { post });
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("no-op when enabled:false (AC3)", async () => {
    const { post, calls } = spyPoster();
    const ok = await notify(
      "work-complete",
      WC,
      cfgWith({ enabled: false, discordWebhookUrl: WEBHOOK }),
      { post }
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("no-op when no URL is configured anywhere", async () => {
    delete process.env.ZSTACK_DISCORD_WEBHOOK;
    const { post, calls } = spyPoster();
    const ok = await notify("work-complete", WC, cfgWith({ enabled: true }), { post });
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("per-event toggle off suppresses only that event (AC4)", async () => {
    const { post, calls } = spyPoster();
    const cfg = cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK, events: { "ticket-parked": false } });
    const off = await notify("ticket-parked", PARK, cfg, { post });
    expect(off).toBe(false);
    expect(calls.length).toBe(0);
    // A key not listed defaults ON.
    const on = await notify("human-pause", PAUSE, cfg, { post });
    expect(on).toBe(true);
    expect(calls.length).toBe(1);
  });

  // AC3 (#68): toggling plan-complete off must not touch work-complete (or any
  // other event), and vice versa -- the two are independent keys, not a shared
  // discriminator on one event.
  test("notify: plan event toggle independent", async () => {
    const { post, calls } = spyPoster();
    const cfg = cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK, events: { "plan-complete": false } });
    const off = await notify("plan-complete", PLAN, cfg, { post });
    expect(off).toBe(false);
    expect(calls.length).toBe(0);
    const on = await notify("work-complete", WC, cfg, { post });
    expect(on).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("posts {content} to configured URL when enabled (AC5)", async () => {
    const { post, calls } = spyPoster();
    const ok = await notify("human-pause", PAUSE, cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK }), { post });
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(WEBHOOK);
    expect(calls[0].body.content).toBe(renderNotification("human-pause", PAUSE));
  });

  test("ZSTACK_DISCORD_WEBHOOK supplies/overrides the URL (AC6)", async () => {
    const ENV_URL = "https://discord.com/api/webhooks/999/ENVtoken";
    process.env.ZSTACK_DISCORD_WEBHOOK = ENV_URL;
    const { post, calls } = spyPoster();
    // No discordWebhookUrl in config; env supplies it.
    const ok = await notify("human-pause", PAUSE, cfgWith({ enabled: true }), { post });
    expect(ok).toBe(true);
    expect(calls[0].url).toBe(ENV_URL);
    // And it OVERRIDES a config URL when both are present.
    const { post: post2, calls: calls2 } = spyPoster();
    await notify("human-pause", PAUSE, cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK }), { post: post2 });
    expect(calls2[0].url).toBe(ENV_URL);
  });

  test("throwing poster resolves false and never throws (AC7)", async () => {
    const throwingPost: Poster = async () => {
      throw new Error("network down");
    };
    const ok = await notify(
      "human-pause",
      PAUSE,
      cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK }),
      { post: throwingPost }
    );
    expect(ok).toBe(false);
  });

  test("webhook URL appears in no log line and no rendered message (AC7 secret-safety)", async () => {
    const logs: string[] = [];
    const throwingPost: Poster = async () => {
      throw new Error("network down");
    };
    await notify(
      "human-pause",
      PAUSE,
      cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK }),
      { post: throwingPost, log: (m) => logs.push(m) }
    );
    expect(logs.length).toBeGreaterThan(0); // a failure WAS logged
    for (const m of logs) {
      expect(m.includes(WEBHOOK)).toBe(false); // but never the secret
      expect(m).toContain("human-pause"); // it names the event
    }
    // The rendered content on the success path also never carries the URL.
    const { post, calls } = spyPoster();
    await notify("human-pause", PAUSE, cfgWith({ enabled: true, discordWebhookUrl: WEBHOOK }), { post });
    expect(calls[0].body.content.includes(WEBHOOK)).toBe(false);
  });
});

// -- config-schema notifications branch (AC8) --------------------------------
describe("validateConfig: notifications block shapes", () => {
  const homes: string[] = [];
  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });
  function roundTrip(notifications: BoardConfig["notifications"]): BoardConfig {
    const home = mkdtempSync(join(tmpdir(), "zstack-notify-"));
    homes.push(home);
    const dir = join(home, ".zstack", "projects", "zstack");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfgWith(notifications)));
    return loadConfig("zstack", home);
  }

  test("a well-formed block passes and round-trips through loadConfig", () => {
    const notifications = {
      enabled: true,
      discordWebhookUrl: WEBHOOK,
      events: { "ticket-parked": false, "work-complete": true },
    };
    expect(() => validateConfig(cfgWith(notifications))).not.toThrow();
    const loaded = roundTrip(notifications);
    expect(loaded.notifications).toEqual(notifications);
  });

  test("a non-https discordWebhookUrl throws naming the field, never echoing the value", () => {
    let caught: unknown;
    try {
      validateConfig(cfgWith({ discordWebhookUrl: "my-token" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    const msg = (caught as ZError).message;
    expect(msg).toContain("notifications.discordWebhookUrl");
    expect(msg).not.toContain("my-token"); // the secret is never leaked into the error
  });

  test("an empty-string discordWebhookUrl is rejected", () => {
    expect(() => validateConfig(cfgWith({ discordWebhookUrl: "" }))).toThrow(/notifications\.discordWebhookUrl/);
  });

  test("a non-boolean enabled throws", () => {
    expect(() => validateConfig(cfgWith({ enabled: "yes" as unknown as boolean }))).toThrow(
      /notifications\.enabled/
    );
  });

  // Issue #106: `typeof [] === "object"` and `[] !== null`, so a bare array
  // used to pass the old `typeof n !== "object" || n === null` guard as a
  // valid notifications block. Must now throw naming "notifications", the
  // same as any other wrong-shape value (AC2).
  test("a bare array is rejected, not silently accepted as a valid object (AC2)", () => {
    expect(() =>
      validateConfig(cfgWith(["x"] as unknown as BoardConfig["notifications"]))
    ).toThrow(/"notifications" must be an object/);
  });

  test("a bare array for notifications.events is rejected too", () => {
    expect(() =>
      validateConfig(cfgWith({ events: ["work-complete"] as unknown as Record<string, boolean> }))
    ).toThrow(/"notifications\.events" must be an object/);
  });

  test("an unknown events key throws naming the bad key", () => {
    let caught: unknown;
    try {
      validateConfig(cfgWith({ events: { bogus: true } as Record<string, boolean> as never }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect((caught as ZError).message).toContain("bogus");
  });

  test("a non-boolean events value throws", () => {
    expect(() =>
      validateConfig(cfgWith({ events: { "work-complete": 1 as unknown as boolean } }))
    ).toThrow(/notifications\.events\.work-complete/);
  });

  test("EVENT_KEYS enumerates exactly the seven events", () => {
    expect(([...EVENT_KEYS] as string[]).sort()).toEqual(
      [
        "human-needed",
        "human-pause",
        "plan-complete",
        "safety-violation",
        "ticket-parked",
        "token-burn",
        "work-complete",
      ].sort()
    );
  });
});

// -- CLI (main() edge) --------------------------------------------------------
describe("CLI", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const dir = mkdtempSync(join(tmpdir(), "zstack-notify-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const notify_ts = join(REPO_ROOT, "lib", "notify.ts");
  const run = (args: string[], env?: Record<string, string>) =>
    Bun.spawnSync(["bun", notify_ts, ...args], { stdout: "pipe", stderr: "pipe", env });

  test("render <event> <payload.json> prints the rendered message (AC1)", () => {
    // Create a temp payload file for ticket-parked event
    const payload = PARK;
    const payloadFile = join(dir, "payload.json");
    writeFileSync(payloadFile, JSON.stringify(payload));

    // Run: bun lib/notify.ts render ticket-parked <file>
    const proc = run(["render", "ticket-parked", payloadFile], process.env as Record<string, string>);

    // Assert: exit 0
    expect(proc.exitCode).toBe(0);
    // Assert: stdout equals renderNotification's output byte-for-byte
    const expectedOutput = renderNotification("ticket-parked", payload);
    expect(proc.stdout.toString()).toBe(expectedOutput + "\n");
  });

  test("send <event> <payload.json> --slug <s> prints skipped when config has no notifications block (AC2)", () => {
    // issue #118: this used to write straight to the REAL ~/.zstack/projects/<slug>
    // (via node:os homedir()) and rmSync it afterward -- exactly the pattern the
    // z-uninstall purge path treats as a subtree to delete, and exactly what the
    // full test suite must never touch when it runs inside a reviewer throwaway
    // worktree. Route it through a sandboxed $HOME/$USERPROFILE instead (the same
    // subprocess-env pattern tests/z-loop-tick.test.ts already uses): Bun's
    // os.homedir() resolves a *spawned child's* home from these env vars, so the
    // CLI's real loadConfig(slug) call resolves into the fake home, never the
    // operator's real one.
    const testSlug = "notify-cli-test";
    const fakeHome = mkdtempSync(join(tmpdir(), "zstack-notify-cli-home-"));
    const projectDir = join(fakeHome, ".zstack", "projects", testSlug);
    const configPath = join(projectDir, "config.json");
    mkdirSync(projectDir, { recursive: true });

    try {
      // Write a minimal valid config with no notifications block
      const config = cfgWith(undefined);
      writeFileSync(configPath, JSON.stringify(config));

      // Create a temp payload file
      const payload = PARK;
      const payloadFile = join(dir, "send-payload.json");
      writeFileSync(payloadFile, JSON.stringify(payload));

      // Ensure ZSTACK_DISCORD_WEBHOOK is not set so the config is used, and point
      // HOME/USERPROFILE at the sandbox so the CLI never resolves the real home.
      const env = { ...process.env } as Record<string, string>;
      delete env.ZSTACK_DISCORD_WEBHOOK;
      env.HOME = fakeHome;
      env.USERPROFILE = fakeHome;

      // Run: bun lib/notify.ts send ticket-parked <file> --slug notify-cli-test
      const proc = run(["send", "ticket-parked", payloadFile, "--slug", testSlug], env);

      // Assert: exit 0
      expect(proc.exitCode).toBe(0);
      // Assert: prints "skipped" (because config has no notifications block)
      expect(proc.stdout.toString().trim()).toBe("skipped");
      // Assert: the REAL ~/.zstack was never touched -- the CLI resolved the
      // sandbox home, not the operator's real one (issue #118 AC2/AC3).
      const realProjectDir = join(homedir(), ".zstack", "projects", testSlug);
      expect(existsSync(realProjectDir)).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("render bogus-event <payload.json> exits 1 and names the five valid events (AC3)", () => {
    // Create a temp payload file (content doesn't matter for this test)
    const payloadFile = join(dir, "dummy.json");
    writeFileSync(payloadFile, JSON.stringify(PARK));

    // Run: bun lib/notify.ts render bogus-event <file>
    const proc = run(["render", "bogus-event", payloadFile]);

    // Assert: exit 1
    expect(proc.exitCode).toBe(1);
    // Assert: error names the five valid events
    const stderr = proc.stderr.toString();
    expect(stderr).toContain("Unknown event");
    expect(stderr).toContain("work-complete");
    expect(stderr).toContain("human-pause");
    expect(stderr).toContain("ticket-parked");
    expect(stderr).toContain("safety-violation");
    expect(stderr).toContain("token-burn");
  });
});
