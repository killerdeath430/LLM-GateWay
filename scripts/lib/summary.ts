/**
 * Turns baseline rows (results/*.jsonl) into percentile tables.
 * Callers: scripts/summarize-baseline.ts (Unit 0.4); Unit 1.8 will summarize gateway runs
 * the same way so both tables are comparable.
 *
 * Rules (also stated in the rendered output so the table can't be misread):
 *   - Warm-up rows are never counted.
 *   - Percentiles use only successful calls; failures are counted and listed by kind.
 *   - TTFT can have fewer samples than successful calls (an answer with no visible text has
 *     no TTFT); when that happens the sample count is shown next to the value.
 *   - Percentiles are nearest-rank (scripts/lib/stats.ts): every value is an observed one.
 */
import { PROVIDERS, type Provider, type StreamMeasurement } from "./direct-stream.js";
import { percentile } from "./stats.js";

/** One line of results/baseline_direct.jsonl: run context + the raw measurement. */
export type BaselineRow = {
  runId: string;
  seq: number;
  warmup: boolean;
  rep: number | null;
  promptId: string;
  category: string;
  startedAt: string;
} & StreamMeasurement;

const CATEGORY_ORDER = ["short", "medium", "long"];

function isNumOrNull(x: unknown): boolean {
  return x === null || typeof x === "number";
}

/** Parses JSONL text, checking the fields the summary relies on. Errors name the line. */
export function parseRows(text: string): BaselineRow[] {
  const rows: BaselineRow[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const where = `line ${String(i + 1)}`;
    let x: unknown;
    try {
      x = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    if (typeof x !== "object" || x === null) throw new Error(`${where}: not an object`);
    const r = x as Record<string, unknown>;
    if (typeof r.runId !== "string") throw new Error(`${where}: missing runId`);
    if (!PROVIDERS.includes(r.provider as Provider)) throw new Error(`${where}: bad provider`);
    if (typeof r.warmup !== "boolean" || typeof r.ok !== "boolean") {
      throw new Error(`${where}: warmup and ok must be booleans`);
    }
    if (typeof r.category !== "string") throw new Error(`${where}: missing category`);
    if (!isNumOrNull(r.ttfbMs) || !isNumOrNull(r.ttftMs) || !isNumOrNull(r.totalMs)) {
      throw new Error(`${where}: timings must be numbers or null`);
    }
    rows.push(x as BaselineRow);
  });
  return rows;
}

export interface TimingStats {
  n: number;
  p50: number | undefined;
  p95: number | undefined;
}

export interface GroupStats {
  provider: Provider;
  /** "all" for the per-provider overall row. */
  category: string;
  requestedModels: string[];
  /** Models the provider reported answering with, when different from the requested one. */
  answeringModels: string[];
  attempted: number;
  ok: number;
  /** e.g. { "http 429": 2, "timeout": 1 } */
  failures: Record<string, number>;
  ttfb: TimingStats;
  ttft: TimingStats;
  total: TimingStats;
}

function timing(values: (number | null)[]): TimingStats {
  const xs = values.filter((v): v is number => v !== null);
  return { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95) };
}

function failureKey(r: BaselineRow): string {
  const kind = r.errorKind ?? "unknown";
  return r.httpStatus !== null && kind === "http" ? `http ${String(r.httpStatus)}` : kind;
}

function group(provider: Provider, category: string, rows: BaselineRow[]): GroupStats {
  const ok = rows.filter((r) => r.ok);
  const failures: Record<string, number> = {};
  for (const r of rows) {
    if (r.ok) continue;
    const k = failureKey(r);
    failures[k] = (failures[k] ?? 0) + 1;
  }
  const requested = [...new Set(rows.map((r) => r.requestedModel))];
  const answering = [
    ...new Set(ok.map((r) => r.answeringModel).filter((m): m is string => m !== null)),
  ];
  return {
    provider,
    category,
    requestedModels: requested,
    answeringModels: answering.filter((m) => !requested.includes(m)),
    attempted: rows.length,
    ok: ok.length,
    failures,
    ttfb: timing(ok.map((r) => r.ttfbMs)),
    ttft: timing(ok.map((r) => r.ttftMs)),
    total: timing(ok.map((r) => r.totalMs)),
  };
}

/**
 * Per-provider overall stats, then per provider x category. Refuses rows from more than one
 * run, because mixing runs would blend different conditions into one number.
 */
export function summarize(rows: readonly BaselineRow[]): {
  runId: string;
  overall: GroupStats[];
  byCategory: GroupStats[];
} {
  const runIds = [...new Set(rows.map((r) => r.runId))];
  if (runIds.length !== 1 || runIds[0] === undefined) {
    throw new Error(`expected rows from exactly one run, found ${String(runIds.length)}`);
  }
  const measured = rows.filter((r) => !r.warmup);
  const providers = PROVIDERS.filter((p) => measured.some((r) => r.provider === p));
  const categories = [...new Set(measured.map((r) => r.category))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );

  const overall = providers.map((p) =>
    group(
      p,
      "all",
      measured.filter((r) => r.provider === p),
    ),
  );
  const byCategory = providers.flatMap((p) =>
    categories
      .map((c) =>
        group(
          p,
          c,
          measured.filter((r) => r.provider === p && r.category === c),
        ),
      )
      .filter((g) => g.attempted > 0),
  );
  return { runId: runIds[0], overall, byCategory };
}

function rank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

const ms = (v: number | undefined): string => (v === undefined ? "-" : String(Math.round(v)));

/** TTFT cell: value, plus its sample count when it differs from the successful-call count. */
function cell(t: TimingStats, okCount: number, which: "p50" | "p95"): string {
  const v = ms(t[which]);
  return t.n === okCount ? v : `${v} (n=${String(t.n)})`;
}

function failureText(f: Record<string, number>): string {
  const parts = Object.entries(f).map(([k, n]) => `${String(n)}x ${k}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

function modelText(g: GroupStats): string {
  const req = g.requestedModels.join(", ");
  return g.answeringModels.length === 0
    ? req
    : `${req} (answered as ${g.answeringModels.join(", ")})`;
}

function table(groups: GroupStats[], firstCol: (g: GroupStats) => string, head: string): string {
  const lines = [
    `| ${head} | OK / attempted | TTFB p50 | TTFB p95 | TTFT p50 | TTFT p95 | Total p50 | Total p95 | Failures |`,
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const g of groups) {
    lines.push(
      `| ${firstCol(g)} | ${String(g.ok)} / ${String(g.attempted)} | ` +
        `${cell(g.ttfb, g.ok, "p50")} | ${cell(g.ttfb, g.ok, "p95")} | ` +
        `${cell(g.ttft, g.ok, "p50")} | ${cell(g.ttft, g.ok, "p95")} | ` +
        `${cell(g.total, g.ok, "p50")} | ${cell(g.total, g.ok, "p95")} | ` +
        `${failureText(g.failures)} |`,
    );
  }
  return lines.join("\n");
}

export interface SummaryContext {
  source: string;
  command?: string;
  startedAt?: string;
  gitCommit?: string;
  promptSetSha256?: string;
}

/** Markdown for results/*.summary.md. All times are milliseconds. */
export function renderMarkdown(s: ReturnType<typeof summarize>, ctx: SummaryContext): string {
  const meta = [
    `- Run: \`${s.runId}\``,
    `- Source: \`${ctx.source}\``,
    ctx.command ? `- Command: \`${ctx.command}\`` : null,
    ctx.startedAt ? `- Started: ${ctx.startedAt}` : null,
    ctx.gitCommit ? `- Git commit: \`${ctx.gitCommit}\`` : null,
    ctx.promptSetSha256 ? `- Prompt set sha256: \`${ctx.promptSetSha256}\`` : null,
  ].filter((l): l is string => l !== null);

  return [
    "# Direct baseline summary",
    "",
    ...meta,
    "",
    "All times in ms. Nearest-rank percentiles over successful, non-warm-up calls only.",
    "TTFB = first response body byte; TTFT = first visible answer text (hidden reasoning",
    "excluded); Total = end of stream.",
    "",
    "## Per provider",
    "",
    table(s.overall, (g) => `${g.provider} (${modelText(g)})`, "Provider (model)"),
    "",
    "## Per provider and prompt category",
    "",
    table(s.byCategory, (g) => `${g.provider} / ${g.category}`, "Provider / category"),
    "",
  ].join("\n");
}
