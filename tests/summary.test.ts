import { describe, expect, it } from "vitest";
import { type Provider } from "../scripts/lib/direct-stream.js";
import { type BaselineRow, parseRows, renderMarkdown, summarize } from "../scripts/lib/summary.js";

let seq = 0;
function row(
  provider: Provider,
  over: Partial<BaselineRow> & { totalMs?: number | null } = {},
): BaselineRow {
  const total = over.totalMs ?? 100;
  return {
    runId: "run-1",
    seq: seq++,
    warmup: false,
    rep: 1,
    promptId: "s01",
    category: "short",
    startedAt: "2026-11-28T00:00:00.000Z",
    provider,
    requestedModel: `${provider}-model`,
    ok: true,
    httpStatus: 200,
    errorKind: null,
    errorMessage: null,
    ttfbMs: total / 2,
    ttftMs: total / 2,
    totalMs: total,
    answeringModel: `${provider}-model`,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: null,
    finishReason: "stop",
    answerChars: 20,
    ...over,
  };
}

describe("summarize", () => {
  // groq: totals 10..100 (10 ok), plus one huge warm-up and one failed call that must not count
  const rows: BaselineRow[] = [
    row("groq", { warmup: true, rep: null, totalMs: 99_999 }),
    ...Array.from({ length: 10 }, (_, i) => row("groq", { totalMs: (i + 1) * 10 })),
    row("groq", {
      ok: false,
      httpStatus: 429,
      errorKind: "http",
      errorMessage: "rate limited",
      ttfbMs: null,
      ttftMs: null,
      totalMs: 5,
    }),
    row("ollama", { category: "long", totalMs: 1000, ttftMs: null }),
    row("ollama", { category: "long", totalMs: 3000 }),
    row("ollama", {
      category: "short",
      ok: false,
      errorKind: "timeout",
      httpStatus: 200,
      totalMs: 180_000,
    }),
  ];
  const s = summarize(rows);
  const groq = s.overall.find((g) => g.provider === "groq");
  const ollama = s.overall.find((g) => g.provider === "ollama");

  it("excludes warm-ups entirely and failures from percentiles, but counts failures", () => {
    expect(groq?.attempted).toBe(11);
    expect(groq?.ok).toBe(10);
    expect(groq?.failures).toEqual({ "http 429": 1 });
    expect(groq?.total).toEqual({ n: 10, p50: 50, p95: 100 });
    expect(groq?.ttfb).toEqual({ n: 10, p50: 25, p95: 50 });
  });

  it("labels failures by kind, and http failures by status", () => {
    expect(ollama?.failures).toEqual({ timeout: 1 });
  });

  it("gives TTFT its own sample count when some answers had no visible text", () => {
    expect(ollama?.ok).toBe(2);
    expect(ollama?.ttft.n).toBe(1);
  });

  it("orders providers like PROVIDERS and categories short -> medium -> long", () => {
    expect(s.overall.map((g) => g.provider)).toEqual(["groq", "ollama"]);
    expect(s.byCategory.map((g) => `${g.provider}/${g.category}`)).toEqual([
      "groq/short",
      "ollama/short",
      "ollama/long",
    ]);
  });

  it("flags a model that answered under a different name than requested", () => {
    const r = summarize([row("gemini", { answeringModel: "gemini-other" })]);
    expect(r.overall[0]?.answeringModels).toEqual(["gemini-other"]);
  });

  it("refuses rows from more than one run", () => {
    expect(() => summarize([row("groq"), row("groq", { runId: "run-2" })])).toThrow(/one run/);
    expect(() => summarize([])).toThrow(/one run/);
  });

  it("renders a markdown table with counts, rounded ms, failures and TTFT sample size", () => {
    const md = renderMarkdown(s, { source: "results/x.jsonl", command: "npm run baseline" });
    expect(md).toContain(
      "| groq (groq-model) | 10 / 11 | 25 | 50 | 25 | 50 | 50 | 100 | 1x http 429 |",
    );
    expect(md).toContain("(n=1)");
    expect(md).toContain("`npm run baseline`");
  });
});

describe("parseRows", () => {
  it("round-trips JSONL and skips blank lines (including CRLF)", () => {
    const a = row("groq");
    const b = row("gemini");
    const text = `${JSON.stringify(a)}\r\n\n${JSON.stringify(b)}\n`;
    expect(parseRows(text)).toEqual([a, b]);
  });

  it("names the offending line", () => {
    const good = JSON.stringify(row("groq"));
    expect(() => parseRows(`${good}\n{oops`)).toThrow(/line 2: not valid JSON/);
    expect(() => parseRows(JSON.stringify({ ...row("groq"), provider: "openai" }))).toThrow(
      /line 1: bad provider/,
    );
    expect(() => parseRows(JSON.stringify({ ...row("groq"), totalMs: "12" }))).toThrow(/line 1/);
  });
});
