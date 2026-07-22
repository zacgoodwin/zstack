// Deterministic cost-saving suggestion helper for /z-plan's terminal Step 11
// (issue #64). Same shape lib/estimate.ts and lib/cost.ts already use: pure
// compute function + a trust-boundary loader + a thin CLI main(). Per
// ESTIMATION.md / PRINCIPLES.md's latent-vs-deterministic split, the
// ARITHMETIC here (sum of Estimates, per-tier grouping, which tickets share a
// file, the single most expensive ticket) is deterministic space -- this file
// computes it. Only the WORDING that turns these facts into sentences is
// latent, and that lives in z-plan/SKILL.md's Step 11, never here.
import { handleCliError, readJson } from "./cli.ts";
import { ZError } from "./config.ts";
import { roundCents } from "./estimate.ts";

export interface PlannedTicket {
  number: number;
  title: string;
  model: string; // "haiku" | "sonnet" | "opus" | "fable" (the board's Model field)
  modelEffort: string; // "low" | "medium" | "high" | "xhigh" (Model Effort field)
  estimate: number; // dollars (Estimate field)
  files: string[]; // real file paths this ticket's ## Plan touches
}

export interface TierGroup {
  tier: string; // `${model}-${modelEffort}`, e.g. "fable-xhigh"
  model: string;
  modelEffort: string;
  tickets: number[]; // ascending
  subtotal: number; // dollars, rounded to the cent
}

export interface FileCluster {
  file: string;
  tickets: number[]; // ascending, length >= 2
}

export type SuggestionKind = "high-cost-ticket" | "shared-file-cluster" | "low-tier-batch";

export interface CostSuggestion {
  kind: SuggestionKind;
  tickets: number[];
  fact: string; // a deterministic DATA sentence -- z-plan/SKILL.md Step 11 phrases the final prose
}

export interface CostBreakdown {
  totalEstimate: number;
  byTier: TierGroup[];
  sharedFileClusters: FileCluster[];
  topCostTicket: { number: number; title: string; estimate: number } | null;
  suggestions: CostSuggestion[];
}

export function costSuggestions(tickets: PlannedTicket[]): CostBreakdown {
  if (tickets.length === 0) {
    return { totalEstimate: 0, byTier: [], sharedFileClusters: [], topCostTicket: null, suggestions: [] };
  }

  const totalEstimate = roundCents(tickets.reduce((sum, t) => sum + t.estimate, 0));

  // byTier: group by the literal `${model}-${modelEffort}` string; subtotal
  // rounded once per group; sort by subtotal descending, tie-break tier asc.
  const tierGroups = new Map<string, { model: string; modelEffort: string; tickets: number[]; sum: number }>();
  for (const t of tickets) {
    const tier = `${t.model}-${t.modelEffort}`;
    const g = tierGroups.get(tier) ?? { model: t.model, modelEffort: t.modelEffort, tickets: [], sum: 0 };
    g.tickets.push(t.number);
    g.sum += t.estimate;
    tierGroups.set(tier, g);
  }
  const byTier: TierGroup[] = [...tierGroups.entries()]
    .map(([tier, g]) => ({
      tier,
      model: g.model,
      modelEffort: g.modelEffort,
      tickets: [...g.tickets].sort((a, b) => a - b),
      subtotal: roundCents(g.sum),
    }))
    .sort((a, b) => b.subtotal - a.subtotal || a.tier.localeCompare(b.tier));

  // sharedFileClusters: every distinct file named by 2+ tickets; sort by
  // cluster size descending, tie-break file ascending.
  const fileTickets = new Map<string, number[]>();
  for (const t of tickets) {
    for (const f of t.files) {
      const arr = fileTickets.get(f) ?? [];
      arr.push(t.number);
      fileTickets.set(f, arr);
    }
  }
  const sharedFileClusters: FileCluster[] = [...fileTickets.entries()]
    .filter(([, nums]) => nums.length >= 2)
    .map(([file, nums]) => ({ file, tickets: [...nums].sort((a, b) => a - b) }))
    .sort((a, b) => b.tickets.length - a.tickets.length || a.file.localeCompare(b.file));

  // topCostTicket: highest estimate; tie-break lowest ticket number.
  let top = tickets[0];
  for (const t of tickets) {
    if (t.estimate > top.estimate || (t.estimate === top.estimate && t.number < top.number)) top = t;
  }
  const topCostTicket = { number: top.number, title: top.title, estimate: top.estimate };

  const suggestions: CostSuggestion[] = [];

  // 1. high-cost-ticket: one per fable ticket (any effort), ascending by number.
  // ESTIMATION.md: fable is 2x Opus price and "earns its cost only when one
  // clean pass replaces two", so every fable ticket is worth a second look.
  const fableTickets = tickets.filter((t) => t.model === "fable").sort((a, b) => a.number - b.number);
  for (const t of fableTickets) {
    suggestions.push({
      kind: "high-cost-ticket",
      tickets: [t.number],
      fact: `#${t.number} ("${t.title}") is ${t.model}-${t.modelEffort} ($${t.estimate.toFixed(2)}).`,
    });
  }

  // 2. shared-file-cluster: one per cluster, same order as sharedFileClusters.
  for (const c of sharedFileClusters) {
    suggestions.push({
      kind: "shared-file-cluster",
      tickets: c.tickets,
      fact: `${c.file} is touched by ${c.tickets.length} tickets: ${c.tickets.map((n) => `#${n}`).join(", ")}.`,
    });
  }

  // 3. low-tier-batch: at most one, when 2+ tickets share the haiku-low tier
  // (mechanical, tightly-specified work -- ESTIMATION.md's own description).
  const haikuLow = tickets
    .filter((t) => t.model === "haiku" && t.modelEffort === "low")
    .map((t) => t.number)
    .sort((a, b) => a - b);
  if (haikuLow.length >= 2) {
    suggestions.push({
      kind: "low-tier-batch",
      tickets: haikuLow,
      fact: `${haikuLow.length} tickets are haiku-low mechanical work: ${haikuLow.map((n) => `#${n}`).join(", ")}.`,
    });
  }

  return { totalEstimate, byTier, sharedFileClusters, topCostTicket, suggestions };
}

// -- trust-boundary loader -----------------------------------------------------
// Mirrors loadBuckets's per-field type loop (lib/estimate.ts:146-181, issue
// #14 item 18): key presence alone is not enough -- a wrong-typed field must
// reject with a ZError naming the ticket and the field, before any math runs,
// never a raw TypeError.
const STRING_FIELDS = ["title", "model", "modelEffort"] as const;

function validatePlannedTicket(entry: unknown, index: number, path: string): PlannedTicket {
  const t = (entry ?? {}) as Record<string, unknown>;
  const numOk = typeof t.number === "number" && Number.isFinite(t.number);
  const ticketLabel = numOk ? `#${t.number}` : `index ${index}`;
  const where = `Planned batch at ${path}, ticket ${ticketLabel}`;

  if (!numOk) {
    throw new ZError(`${where}: "number" must be a finite number, got ${JSON.stringify(t.number)}.`);
  }
  for (const key of STRING_FIELDS) {
    const v = t[key];
    if (typeof v !== "string" || !v) {
      throw new ZError(`${where}: "${key}" must be a non-empty string, got ${JSON.stringify(v)}.`);
    }
  }
  if (typeof t.estimate !== "number" || !Number.isFinite(t.estimate) || t.estimate < 0) {
    throw new ZError(`${where}: "estimate" must be a non-negative finite number, got ${JSON.stringify(t.estimate)}.`);
  }
  if (!Array.isArray(t.files) || t.files.some((f) => typeof f !== "string")) {
    throw new ZError(`${where}: "files" must be an array of strings, got ${JSON.stringify(t.files)}.`);
  }

  return {
    number: t.number as number,
    title: t.title as string,
    model: t.model as string,
    modelEffort: t.modelEffort as string,
    estimate: t.estimate as number,
    files: t.files as string[],
  };
}

export function loadPlannedTickets(path: string): PlannedTicket[] {
  const raw = readJson(path);
  if (!Array.isArray(raw)) {
    throw new ZError(`Planned batch at ${path} must be a JSON array of tickets, got ${typeof raw}.`);
  }
  return raw.map((entry, i) => validatePlannedTicket(entry, i, path));
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `z-cost-suggest <planned-batch.json>

  planned-batch.json: PlannedTicket[] -- [{number, title, model, modelEffort,
  estimate, files}, ...], the exact data /z-plan's Step 6/Step 10 already wrote
  this run (z-plan/SKILL.md Step 11).
  Prints one CostBreakdown JSON object to stdout (totalEstimate, byTier,
  sharedFileClusters, topCostTicket, suggestions) -- the deterministic half of
  the cost-saving report; turning it into prose is Step 11's job, not this CLI's.`;

export function main(argv: string[]): number {
  const path = argv[0];
  if (!path || path === "-h" || path === "--help") {
    console.log(USAGE);
    return path ? 0 : 1;
  }

  try {
    const tickets = loadPlannedTickets(path);
    const result = costSuggestions(tickets);
    console.log(JSON.stringify(result));
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
