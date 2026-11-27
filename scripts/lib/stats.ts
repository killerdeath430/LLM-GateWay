/**
 * Percentiles for the latency baseline.
 *
 * Definition used everywhere in this repo: **nearest-rank**. The p-th percentile of n samples
 * is the value at 1-based rank ceil(p/100 * n) in ascending order. It always returns a value
 * that was actually observed (no interpolation), so every reported p50/p95 can be found as a
 * line in results/*.jsonl.
 *
 * Example: with n = 100 samples, p95 is the 95th smallest value; with n = 20, p95 is the 19th.
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!(p > 0 && p <= 100))
    throw new RangeError(`percentile p must be in (0, 100], got ${String(p)}`);
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1];
}
