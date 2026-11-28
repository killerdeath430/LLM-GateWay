/**
 * The order and pacing of baseline calls, as pure logic (no I/O) so it can be tested offline.
 * Caller: scripts/baseline.ts (Unit 0.4). Unit 1.8 reuses the same idea to interleave direct
 * and gateway calls.
 *
 * Schedule: one warm-up call per provider, then for each rep, for each prompt, all providers
 * back to back ("interleaved"). The provider order rotates every round, so no provider is
 * always first (cold-ish connection) or always last (right after another provider's call).
 * Rotation is deterministic, so a rerun issues the exact same sequence: no random seed needed.
 *
 * Pacing: a minimum start-to-start gap per provider, to stay under free-tier rate limits.
 */
import type { Provider } from "./direct-stream.js";

export interface PlanEntry {
  /** 0-based position in the run; also the line order in results/*.jsonl. */
  seq: number;
  warmup: boolean;
  /** 1-based repetition number; null for warm-ups. */
  rep: number | null;
  promptId: string;
  provider: Provider;
}

/**
 * Builds the full call order. Warm-ups use the first prompt id. With 20 prompts, 5 reps and
 * 3 providers this is 3 + 300 = 303 entries.
 */
export function buildSchedule(
  promptIds: readonly string[],
  reps: number,
  providers: readonly Provider[],
): PlanEntry[] {
  const first = promptIds[0];
  if (first === undefined) throw new Error("schedule needs at least one prompt");
  if (!Number.isInteger(reps) || reps < 1) throw new Error("reps must be a positive integer");
  if (providers.length === 0) throw new Error("schedule needs at least one provider");

  const out: PlanEntry[] = [];
  for (const provider of providers) {
    out.push({ seq: out.length, warmup: true, rep: null, promptId: first, provider });
  }
  let round = 0;
  for (let rep = 1; rep <= reps; rep++) {
    for (const promptId of promptIds) {
      for (const provider of rotate(providers, round)) {
        out.push({ seq: out.length, warmup: false, rep, promptId, provider });
      }
      round++;
    }
  }
  return out;
}

/** rotate([a,b,c], 1) -> [b,c,a]. */
export function rotate<T>(xs: readonly T[], by: number): T[] {
  const k = ((by % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

/**
 * Enforces a minimum gap between the *starts* of two calls to the same provider, plus a
 * longer cool-down after a rate-limit response. The clock and sleep are injected so tests
 * can use a fake clock.
 */
export class Pacer {
  private readonly nextAllowed = new Map<Provider, number>();

  constructor(
    private readonly gapsMs: Readonly<Record<Provider, number>>,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Waits until `provider` may be called, then reserves the slot. Returns the ms waited. */
  async acquire(provider: Provider): Promise<number> {
    const wait = Math.max(0, (this.nextAllowed.get(provider) ?? 0) - this.now());
    if (wait > 0) await this.sleep(wait);
    this.nextAllowed.set(provider, this.now() + this.gapsMs[provider]);
    return wait;
  }

  /** After a 429: hold `provider` back for at least `ms` from now. Never shortens a wait. */
  coolDown(provider: Provider, ms: number): void {
    const until = this.now() + ms;
    this.nextAllowed.set(provider, Math.max(this.nextAllowed.get(provider) ?? 0, until));
  }
}
