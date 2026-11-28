import { describe, expect, it } from "vitest";
import { buildSchedule, Pacer, rotate } from "../scripts/lib/baseline-plan.js";
import { PROVIDERS, type Provider } from "../scripts/lib/direct-stream.js";

const ids20 = Array.from({ length: 20 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);

describe("buildSchedule", () => {
  const s = buildSchedule(ids20, 5, PROVIDERS);

  it("has 3 warm-ups + 20 prompts x 5 reps x 3 providers = 303 entries, seq in order", () => {
    expect(s).toHaveLength(303);
    expect(s.map((e) => e.seq)).toEqual(s.map((_, i) => i));
  });

  it("starts with one warm-up per provider on the first prompt, and only there", () => {
    expect(s.slice(0, 3).every((e) => e.warmup && e.rep === null && e.promptId === "p01")).toBe(
      true,
    );
    expect(new Set(s.slice(0, 3).map((e) => e.provider))).toEqual(new Set(PROVIDERS));
    expect(s.slice(3).some((e) => e.warmup)).toBe(false);
  });

  it("runs every (rep, prompt) on all providers back to back", () => {
    const measured = s.slice(3);
    for (let i = 0; i < measured.length; i += 3) {
      const round = measured.slice(i, i + 3);
      expect(new Set(round.map((e) => `${String(e.rep)}/${e.promptId}`)).size).toBe(1);
      expect(new Set(round.map((e) => e.provider))).toEqual(new Set(PROVIDERS));
    }
  });

  it("rotates provider order so each provider is first about equally often", () => {
    const firsts = new Map<Provider, number>();
    const measured = s.slice(3);
    for (let i = 0; i < measured.length; i += 3) {
      const p = measured[i]?.provider;
      if (p) firsts.set(p, (firsts.get(p) ?? 0) + 1);
    }
    const counts = [...firsts.values()];
    expect(counts).toHaveLength(3);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1); // 34/33/33
  });

  it("is deterministic", () => {
    expect(buildSchedule(ids20, 5, PROVIDERS)).toEqual(s);
  });

  it("rejects bad input", () => {
    expect(() => buildSchedule([], 5, PROVIDERS)).toThrow();
    expect(() => buildSchedule(ids20, 0, PROVIDERS)).toThrow();
    expect(() => buildSchedule(ids20, 1.5, PROVIDERS)).toThrow();
  });
});

describe("rotate", () => {
  it("shifts left and wraps", () => {
    expect(rotate(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(rotate(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], 5)).toEqual(["c", "a", "b"]);
  });
});

describe("Pacer (fake clock)", () => {
  function fake() {
    let t = 1_000_000;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: (ms: number) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      advance: (ms: number) => (t += ms),
      slept,
    };
  }
  const gaps = { gemini: 5000, groq: 10_000, ollama: 0 };

  it("first call per provider never waits", async () => {
    const c = fake();
    const p = new Pacer(gaps, c.now, c.sleep);
    expect(await p.acquire("groq")).toBe(0);
    expect(await p.acquire("gemini")).toBe(0);
    expect(c.slept).toEqual([]);
  });

  it("waits only the remainder of the start-to-start gap", async () => {
    const c = fake();
    const p = new Pacer(gaps, c.now, c.sleep);
    await p.acquire("groq");
    c.advance(3000); // the call itself took 3 s
    expect(await p.acquire("groq")).toBe(7000);
    c.advance(12_000); // more than the gap already passed
    expect(await p.acquire("groq")).toBe(0);
  });

  it("keeps providers independent and never waits on a zero gap", async () => {
    const c = fake();
    const p = new Pacer(gaps, c.now, c.sleep);
    await p.acquire("groq");
    expect(await p.acquire("ollama")).toBe(0);
    expect(await p.acquire("ollama")).toBe(0);
    expect(await p.acquire("gemini")).toBe(0);
  });

  it("coolDown holds a provider back, but never shortens an existing wait", async () => {
    const c = fake();
    const p = new Pacer(gaps, c.now, c.sleep);
    await p.acquire("gemini");
    p.coolDown("gemini", 60_000);
    expect(await p.acquire("gemini")).toBe(60_000);

    await p.acquire("groq"); // next groq slot is 10 s away
    p.coolDown("groq", 1000);
    expect(await p.acquire("groq")).toBe(10_000);
  });
});
