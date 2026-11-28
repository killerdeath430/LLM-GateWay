/**
 * Unit 0.4: summarize a baseline run.
 * Usage: `npm run baseline:summary` (defaults to results/baseline_direct.jsonl), or
 *   npm run baseline:summary -- results/trial.jsonl
 *
 * Reads <name>.jsonl and, if present, <name>.meta.json; writes <name>.summary.md and prints
 * it. The summary is derived data: it can be regenerated from the .jsonl at any time.
 * Logic lives in scripts/lib/summary.ts.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseRows, renderMarkdown, summarize, type SummaryContext } from "./lib/summary.js";

const input = resolve(process.argv[2] ?? "results/baseline_direct.jsonl");
const base = input.replace(/\.jsonl$/, "");
const metaPath = `${base}.meta.json`;
const outPath = `${base}.summary.md`;

const rows = parseRows(await readFile(input, "utf8"));
const ctx: SummaryContext = { source: relative(process.cwd(), input).replaceAll("\\", "/") };
if (existsSync(metaPath)) {
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  if (typeof meta.command === "string") ctx.command = meta.command;
  if (typeof meta.startedAt === "string") ctx.startedAt = meta.startedAt;
  if (typeof meta.gitCommit === "string") {
    ctx.gitCommit = meta.gitDirty === true ? `${meta.gitCommit} (dirty)` : meta.gitCommit;
  }
  if (typeof meta.promptSetSha256 === "string") ctx.promptSetSha256 = meta.promptSetSha256;
  if (meta.finishedAt === null) console.warn("warning: meta says this run never finished");
}

const md = renderMarkdown(summarize(rows), ctx);
await writeFile(outPath, md);
console.log(md);
console.log(`written: ${outPath}`);
