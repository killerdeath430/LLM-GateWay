/**
 * Unit 0.4: direct (no gateway) streaming latency baseline.
 * Usage: `npm run baseline` (full run), or a small trial, e.g.
 *   npm run baseline -- --reps 1 --prompts s01,m01 --out results/trial.jsonl
 *
 * Flow: load the frozen prompt set (hash-checked) -> build the interleaved schedule
 * (scripts/lib/baseline-plan.ts) -> for each entry: wait for the provider's pacing slot,
 * streamDirect() it (scripts/lib/direct-stream.ts), append one JSON line -> write the meta
 * file. Summarize afterwards with `npm run baseline:summary`.
 *
 * Measurement rules:
 *   - No retries: a retry would hide real provider behaviour. Failures are recorded as rows.
 *   - After a 429 the provider cools down (default 60 s) before its next scheduled call.
 *   - Rows are appended as they finish, so an interrupted run keeps what it measured.
 *   - Refuses to overwrite an existing results file: results are evidence, never replaced.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSchedule, Pacer } from "./lib/baseline-plan.js";
import { type DirectConfig, type Provider, PROVIDERS, streamDirect } from "./lib/direct-stream.js";
import { loadFrozenPromptSet } from "./lib/prompt-set.js";
import type { BaselineRow } from "./lib/summary.js";

// Same models as scripts/connectivity.ts (chosen 2026-11-26). Phase 1 moves them to config.
const MODELS: Record<Provider, string> = {
  gemini: "gemini-3.1-flash-lite",
  groq: "openai/gpt-oss-20b",
  ollama: "qwen2.5-coder:7b",
};

const { values: args } = parseArgs({
  options: {
    reps: { type: "string", default: "5" },
    prompts: { type: "string" }, // comma-separated ids; default: all
    out: { type: "string", default: "results/baseline_direct.jsonl" },
    // Start-to-start gaps. Groq: 8K tokens/min free tier, ~1K tokens per call -> 10 s.
    // Gemini: 15 requests/min -> 4 s minimum; 5 s leaves headroom.
    "gap-groq": { type: "string", default: "10000" },
    "gap-gemini": { type: "string", default: "5000" },
    "gap-ollama": { type: "string", default: "0" },
    cooldown: { type: "string", default: "60000" },
    // Generous: a 512-token answer from the local 7B model can take a minute or more.
    timeout: { type: "string", default: "180000" },
  },
});

function intArg(name: string, raw: string | undefined, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer >= ${String(min)}, got ${String(raw)}`);
  }
  return n;
}

function git(...a: string[]): string {
  try {
    return execFileSync("git", a, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const reps = intArg("reps", args.reps, 1);
  const gaps: Record<Provider, number> = {
    gemini: intArg("gap-gemini", args["gap-gemini"], 0),
    groq: intArg("gap-groq", args["gap-groq"], 0),
    ollama: intArg("gap-ollama", args["gap-ollama"], 0),
  };
  const cooldownMs = intArg("cooldown", args.cooldown, 0);
  const timeoutMs = intArg("timeout", args.timeout, 1000);
  const outPath = resolve(args.out);
  const metaPath = outPath.replace(/\.jsonl$/, "") + ".meta.json";

  if (existsSync(outPath) || existsSync(metaPath)) {
    console.error(`refusing to overwrite ${outPath} (or its .meta.json). Use a new --out.`);
    return 1;
  }

  const cfg: DirectConfig = {
    models: MODELS,
    geminiApiKey: process.env.GEMINI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaKeepAlive: "30m",
    timeoutMs,
  };
  // Fail before the first call rather than produce a run with a provider missing.
  const missing = [
    cfg.geminiApiKey ? null : "GEMINI_API_KEY",
    cfg.groqApiKey ? null : "GROQ_API_KEY",
  ].filter((k) => k !== null);
  if (missing.length > 0) {
    console.error(`missing env: ${missing.join(", ")} (see .env.example)`);
    return 1;
  }

  const { set, sha256 } = await loadFrozenPromptSet();
  const wanted = args.prompts?.split(",").map((s) => s.trim());
  const prompts = wanted ? set.prompts.filter((p) => wanted.includes(p.id)) : set.prompts;
  const unknown = wanted?.filter((id) => !set.prompts.some((p) => p.id === id)) ?? [];
  if (unknown.length > 0 || prompts.length === 0) {
    console.error(`unknown or empty --prompts: ${unknown.join(", ") || "(none selected)"}`);
    return 1;
  }
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const schedule = buildSchedule(
    prompts.map((p) => p.id),
    reps,
    PROVIDERS,
  );

  const startedAt = new Date().toISOString();
  const runId = `direct-${startedAt.replace(/[:.]/g, "-")}`;
  const meta = {
    runId,
    kind: "direct-baseline",
    startedAt,
    finishedAt: null as string | null,
    command: ["npm run baseline --", ...process.argv.slice(2)].join(" "),
    gitCommit: git("rev-parse", "HEAD"),
    gitDirty: git("status", "--porcelain") !== "",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    models: MODELS,
    promptSetVersion: set.version,
    promptSetSha256: sha256,
    temperature: set.temperature,
    reps,
    promptIds: prompts.map((p) => p.id),
    plannedCalls: schedule.length,
    gapsMs: gaps,
    cooldownMs,
    timeoutMs,
    ollamaKeepAlive: cfg.ollamaKeepAlive,
    completedCalls: 0,
    failedCalls: 0,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  await writeFile(outPath, "");
  console.log(`run ${runId}: ${String(schedule.length)} calls -> ${outPath}`);

  const pacer = new Pacer(gaps);
  for (const entry of schedule) {
    const prompt = byId.get(entry.promptId);
    if (!prompt) throw new Error(`schedule references unknown prompt ${entry.promptId}`);
    await pacer.acquire(entry.provider);
    const rowStart = new Date().toISOString();
    const m = await streamDirect(
      entry.provider,
      { messages: prompt.messages, maxTokens: prompt.max_tokens, temperature: set.temperature },
      cfg,
    );
    if (m.httpStatus === 429) pacer.coolDown(entry.provider, cooldownMs);

    const row: BaselineRow = {
      runId,
      seq: entry.seq,
      warmup: entry.warmup,
      rep: entry.rep,
      promptId: entry.promptId,
      category: prompt.category,
      startedAt: rowStart,
      ...m,
    };
    await appendFile(outPath, JSON.stringify(row) + "\n");
    meta.completedCalls++;
    if (!m.ok) meta.failedCalls++;

    const t = (v: number | null) => (v === null ? "-" : `${String(Math.round(v))}ms`);
    console.log(
      `[${String(entry.seq + 1)}/${String(schedule.length)}] ` +
        `${entry.warmup ? "warmup" : `rep ${String(entry.rep)}`} ${entry.promptId} ` +
        `${entry.provider.padEnd(6)} ` +
        (m.ok
          ? `ok   ttfb ${t(m.ttfbMs)} ttft ${t(m.ttftMs)} total ${t(m.totalMs)}`
          : `FAIL ${m.errorKind ?? "?"} ${m.errorMessage?.slice(0, 120) ?? ""}`),
    );
  }

  meta.finishedAt = new Date().toISOString();
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(
    `done: ${String(meta.completedCalls)} calls, ${String(meta.failedCalls)} failed. ` +
      `Next: npm run baseline:summary -- ${args.out}`,
  );
  return 0;
}

process.exitCode = await main();
