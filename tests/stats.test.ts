import { describe, expect, it } from "vitest";
import { percentile } from "../scripts/lib/stats.js";

describe("percentile (nearest-rank)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("p50 and p95 of 1..100 are 50 and 95", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
  });

  it("does not depend on input order and does not mutate the input", () => {
    const shuffled = [5, 1, 4, 2, 3];
    expect(percentile(shuffled, 50)).toBe(3);
    expect(shuffled).toEqual([5, 1, 4, 2, 3]);
  });

  it("always returns an observed value (no interpolation)", () => {
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile([10, 20], 95)).toBe(20);
  });

  it("p100 is the max; a single sample is every percentile", () => {
    expect(percentile([3, 9, 1], 100)).toBe(9);
    expect(percentile([42], 1)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("returns undefined for no samples and rejects p outside (0, 100]", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});
