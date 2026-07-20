// The single side-effecting notification edge (ticket #60). Same discipline that
// makes lib/board.ts the sole `gh` caller and lib/endloop.ts deliberately
// network-free (endloop.ts:8-14): the pure decision code (loop.ts, endloop.ts)
// never gains a network call; the ORCHESTRATOR (z-loop/z-plan SKILL.md) makes
// thin `notify.ts` CLI calls at the moments the state machine already surfaces.
//
// renderNotification is pure (deterministic, zero I/O -- no Date.now, no config,
// no URL, so the webhook can never leak into the message text). notify() renders
// and posts to a Discord webhook, degrading to a no-op when unconfigured/disabled
// and swallowing every network failure -- it never throws and never blocks the
// drain. The transport (Poster) is injected the way lib/board.ts injects
// Sleep/GraphQLExecutor, so gate tests run with zero network.
//
// The type edge to config.ts is one-directional at runtime: notify.ts imports
// BoardConfig type-only (erased), config.ts imports EventKey type-only (erased).
// The one runtime cycle (config -> config-schema -> notify -> config, via
// loadConfig in the CLI and EVENT_KEYS in the schema) is benign: every
// cross-module reference lives inside a function body, never at module top level.
import { handleCliError, parseFlags, readJson } from "./cli.ts";
import { loadConfig, ZError, type BoardConfig } from "./config.ts";

export { ZError } from "./config.ts";

// Per-event payload map: renderNotification is type-checked per event, and each
// key is 1:1 with one of the orchestrator's trigger moments.
export interface PayloadByEvent {
  "work-complete": {
    slug: string;
    loopCount: number;
    done: number;
    questions: number;
    blocked: number;
    skipped: number;
    totalDollars: number;
    verdict?: "red" | "green";
  };
  "human-pause": { ticket: number; title: string; note: string };
  "ticket-parked": {
    ticket: number;
    title: string;
    status: "Questions" | "Blocked" | "Skipped";
    note: string;
  };
  "safety-violation": { control: string; ticket?: number; detail: string };
  "token-burn": { detail: string; ticket?: number };
  // The mid-run breakdown safety control (issue #63): the exact
  // lib/loop.ts HumanNeededStatus shape, sent verbatim as the payload file --
  // duplicated here (not imported from loop.ts) for the same reason every
  // other payload below is its own literal shape: notify.ts never depends on
  // loop.ts at runtime.
  "human-needed": {
    tripped: boolean;
    alreadyNotified: boolean;
    blocked: number;
    skipped: number;
    questions: number;
    initialReadyCount: number;
    percent: number;
    tickets: { blocked: number[]; skipped: number[]; questions: number[] };
  };
}
export type EventKey = keyof PayloadByEvent;

// Discord's hard content limit. ponytail: hard cap (truncate); upgrade path =
// split into multiple messages when a real payload ever exceeds this.
const DISCORD_LIMIT = 2000;

// One deterministic template per event. The mapped-type shape forces every
// EventKey to have a renderer (a new event fails to compile until it is added
// here) and type-checks each renderer's payload against its own event. No
// Date.now, no config read, no URL argument, so the message is reproducible and
// the webhook can never appear in it.

// Formats a ticket-number list for the human-needed template: "none" when
// empty, "#N, #M" otherwise. Local to that one renderer.
const fmtTickets = (nums: number[]): string => (nums.length ? nums.map((n) => `#${n}`).join(", ") : "none");

const RENDERERS: { [K in EventKey]: (p: PayloadByEvent[K]) => string } = {
  "work-complete": (p) =>
    `zstack ${p.slug}: loop ${p.loopCount} complete. ` +
    `done ${p.done}, questions ${p.questions}, blocked ${p.blocked}, skipped ${p.skipped}. ` +
    `spend $${p.totalDollars.toFixed(2)}.${p.verdict ? ` regression ${p.verdict}.` : ""}`,
  "human-pause": (p) => `zstack: needs input on #${p.ticket} ${p.title}. ${p.note}`,
  "ticket-parked": (p) => `zstack: #${p.ticket} ${p.title} → ${p.status}. ${p.note}`,
  "safety-violation": (p) =>
    `zstack: safety control "${p.control}" tripped${p.ticket ? ` on #${p.ticket}` : ""}. ${p.detail}`,
  "token-burn": (p) => `zstack: token-burn guard${p.ticket ? ` on #${p.ticket}` : ""}. ${p.detail}`,
  "human-needed": (p) =>
    `zstack: human-needed threshold crossed. ${p.blocked + p.skipped + p.questions}/${p.initialReadyCount} parked (> ${p.percent}%). ` +
    `Blocked ${fmtTickets(p.tickets.blocked)}. Skipped ${fmtTickets(p.tickets.skipped)}. Questions ${fmtTickets(p.tickets.questions)}.`,
};

// Every valid event, derived from the renderer map so there is one source of
// truth: the CLI usage line and config-schema's `events` key validation both
// read this, and it can never drift from the templates above.
export const EVENT_KEYS = Object.keys(RENDERERS) as EventKey[];

export function isEventKey(s: string): s is EventKey {
  return (EVENT_KEYS as string[]).includes(s);
}

// Pure. Renders the event's template and truncates to Discord's content limit.
export function renderNotification<E extends EventKey>(event: E, p: PayloadByEvent[E]): string {
  const raw = (RENDERERS[event] as (p: PayloadByEvent[E]) => string)(p);
  return raw.length <= DISCORD_LIMIT ? raw : raw.slice(0, DISCORD_LIMIT);
}

// The injected transport seam (mirrors board.ts's GraphQLExecutor). A non-2xx
// response is a failure the default poster turns into a throw, so notify()'s
// catch handles both transport errors and bad HTTP status identically.
export type Poster = (url: string, body: { content: string }) => Promise<void>;

const defaultPost: Poster = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord webhook returned HTTP ${res.status}`);
};

// The side-effecting edge. Returns true only when a message was actually posted;
// every degradation path returns false, and it NEVER throws (a failed post is
// logged and dropped, never retried, never blocking the drain). The log message
// names the event and error only -- never the URL, which is a secret.
export async function notify<E extends EventKey>(
  event: E,
  payload: PayloadByEvent[E],
  cfg: BoardConfig,
  deps: { post?: Poster; log?: (msg: string) => void } = {}
): Promise<boolean> {
  const n = cfg.notifications;
  if (!n || n.enabled === false) return false;
  // Env wins so the secret can stay out of config.json entirely.
  const url = process.env.ZSTACK_DISCORD_WEBHOOK ?? n.discordWebhookUrl;
  if (!url) return false;
  // Every event defaults ON; a missing key is not "off".
  if ((n.events?.[event] ?? true) === false) return false;
  try {
    await (deps.post ?? defaultPost)(url, { content: renderNotification(event, payload) });
    return true;
  } catch (err) {
    deps.log?.(`notify: Discord delivery failed for ${event}: ${(err as Error).message}`);
    return false;
  }
}

// -- CLI ----------------------------------------------------------------------
// The orchestrator's only way in (z-loop/z-plan SKILL.md call this). `render`
// never touches config or the network; `send` loads config and posts, printing
// sent/skipped. Neither ever echoes the resolved webhook URL.
const USAGE = `notify <command> [args]

  send <event> <payload.json> [--slug <s>]   render + post to the configured Discord webhook
                                             (prints "sent"/"skipped"; no-op when unconfigured/disabled)
  render <event> <payload.json>              print the rendered message only (no config, no network)

  events: ${EVENT_KEYS.join(" | ")}
  --slug <name>                              which ~/.zstack/projects/<slug> to use`;

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd !== "send" && cmd !== "render") {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }
  try {
    const { positionals, flags } = parseFlags(argv.slice(1), []);
    const event = positionals[0];
    const payloadPath = positionals[1];
    if (!event || !isEventKey(event)) {
      throw new ZError(`Unknown event "${event ?? ""}". Valid: ${EVENT_KEYS.join(", ")}`);
    }
    if (!payloadPath) throw new ZError(`Usage: notify ${cmd} <event> <payload.json>`);
    const payload = readJson(payloadPath) as PayloadByEvent[typeof event];

    if (cmd === "render") {
      console.log(renderNotification(event, payload));
      return 0;
    }
    // send
    const slug = typeof flags.slug === "string" ? flags.slug : undefined;
    const cfg = loadConfig(slug);
    const ok = await notify(event, payload, cfg, { log: (m) => console.error(m) });
    console.log(ok ? "sent" : "skipped");
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
