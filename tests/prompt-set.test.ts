import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadFrozenPromptSet,
  PROMPT_SET_PATH,
  sha256Hex,
  validatePromptSet,
} from "../scripts/lib/prompt-set.js";

describe("frozen baseline prompt set", () => {
  it("loads, matches its frozen hash, and has 20 prompts split 7/7/6", async () => {
    const { set, sha256 } = await loadFrozenPromptSet();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(set.prompts).toHaveLength(20);
    const count = (c: string) => set.prompts.filter((p) => p.category === c).length;
    expect([count("short"), count("medium"), count("long")]).toEqual([7, 7, 6]);
    expect(set.temperature).toBe(0);
  });

  it("refuses to load if a single byte changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-set-"));
    const original = await readFile(PROMPT_SET_PATH);
    const tampered = Buffer.from(original.toString("utf8").replace("429", "430"), "utf8");
    await writeFile(join(dir, "p.json"), tampered);
    await writeFile(join(dir, "p.sha256"), `${sha256Hex(original)}  p.json\n`);
    await expect(loadFrozenPromptSet(join(dir, "p.json"), join(dir, "p.sha256"))).rejects.toThrow(
      /changed since it was frozen/,
    );
  });
});

describe("validatePromptSet", () => {
  const prompt = (over: Record<string, unknown> = {}) => ({
    id: "s01",
    category: "short",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    ...over,
  });
  const set = (prompts: unknown[]) => ({ version: 1, temperature: 0, prompts });

  it("accepts a minimal valid set", () => {
    expect(validatePromptSet(set([prompt()])).prompts[0]?.id).toBe("s01");
  });

  it.each([
    ["duplicate id", set([prompt(), prompt()]), /duplicate id/],
    ["unknown category", set([prompt({ category: "huge" })]), /category/],
    ["non-integer max_tokens", set([prompt({ max_tokens: 1.5 })]), /max_tokens/],
    ["system message", set([prompt({ messages: [{ role: "system", content: "x" }] })]), /user/],
    ["empty prompts", set([]), /non-empty/],
  ])("rejects %s", (_name, input, message) => {
    expect(() => validatePromptSet(input)).toThrow(message);
  });
});
