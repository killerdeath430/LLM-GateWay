/**
 * Loads the frozen baseline prompt set and refuses to run if it changed.
 *
 * "Frozen" is enforced, not just documented: data/baseline_prompts.sha256 holds the SHA-256
 * of data/baseline_prompts.json as committed before the first measured run. If the file's
 * bytes no longer match, loading fails, because results from different prompt sets must
 * never be mixed. To change prompts, add baseline_prompts_v2.json with its own hash file.
 *
 * Byte stability: .gitattributes forces LF and .prettierignore excludes data/, so neither a
 * Windows checkout nor `npm run format` can silently change the hash.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PROMPT_SET_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "data",
  "baseline_prompts.json",
);
export const PROMPT_SET_HASH_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "data",
  "baseline_prompts.sha256",
);

export type PromptCategory = "short" | "medium" | "long";

export interface BaselinePrompt {
  id: string;
  category: PromptCategory;
  max_tokens: number;
  messages: { role: "user"; content: string }[];
}

export interface PromptSet {
  version: number;
  temperature: number;
  prompts: BaselinePrompt[];
}

const CATEGORIES: readonly string[] = ["short", "medium", "long"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Structural validation with messages that name the offending prompt. */
export function validatePromptSet(x: unknown): PromptSet {
  if (!isRecord(x)) throw new Error("prompt set: top level must be an object");
  const { version, temperature, prompts } = x;
  if (typeof version !== "number") throw new Error("prompt set: `version` must be a number");
  if (typeof temperature !== "number") {
    throw new Error("prompt set: `temperature` must be a number");
  }
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error("prompt set: `prompts` must be a non-empty array");
  }

  const seen = new Set<string>();
  const out: BaselinePrompt[] = prompts.map((p: unknown, i): BaselinePrompt => {
    if (!isRecord(p)) throw new Error(`prompt #${String(i)}: must be an object`);
    const { id, category, max_tokens, messages } = p;
    if (typeof id !== "string" || id === "") throw new Error(`prompt #${String(i)}: missing id`);
    if (seen.has(id)) throw new Error(`prompt ${id}: duplicate id`);
    seen.add(id);
    if (typeof category !== "string" || !CATEGORIES.includes(category)) {
      throw new Error(`prompt ${id}: category must be one of ${CATEGORIES.join(", ")}`);
    }
    if (typeof max_tokens !== "number" || !Number.isInteger(max_tokens) || max_tokens <= 0) {
      throw new Error(`prompt ${id}: max_tokens must be a positive integer`);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error(`prompt ${id}: messages must be a non-empty array`);
    }
    for (const m of messages as unknown[]) {
      // Only user turns: system prompts map differently per provider (Gemini uses
      // systemInstruction), which would make the direct calls unequal.
      if (!isRecord(m) || m.role !== "user" || typeof m.content !== "string" || m.content === "") {
        throw new Error(`prompt ${id}: each message must be {role: "user", content: non-empty}`);
      }
    }
    return {
      id,
      category: category as PromptCategory,
      max_tokens,
      messages: messages as BaselinePrompt["messages"],
    };
  });

  return { version, temperature, prompts: out };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads, hash-checks and validates the prompt set. Returns the set and its SHA-256. */
export async function loadFrozenPromptSet(
  path = PROMPT_SET_PATH,
  hashPath = PROMPT_SET_HASH_PATH,
): Promise<{ set: PromptSet; sha256: string }> {
  const bytes = await readFile(path);
  const actual = sha256Hex(bytes);
  const expected = (await readFile(hashPath, "utf8")).trim().split(/\s+/)[0] ?? "";
  if (actual !== expected) {
    throw new Error(
      `prompt set has changed since it was frozen (sha256 ${actual}, expected ${expected}). ` +
        "Do not edit a frozen set; add a new versioned file instead.",
    );
  }
  return { set: validatePromptSet(JSON.parse(bytes.toString("utf8"))), sha256: actual };
}
