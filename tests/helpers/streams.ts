/** Test helpers: build byte streams the way a network delivers them. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const enc = new TextEncoder();

/** Async iterable of byte chunks, one per string. */
export async function* chunksOf(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield enc.encode(p);
  await Promise.resolve();
}

/** Same text, but delivered one byte per chunk: the worst case for boundary handling. */
export async function* byteByByte(text: string): AsyncGenerator<Uint8Array> {
  for (const b of enc.encode(text)) yield new Uint8Array([b]);
  await Promise.resolve();
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export type Part = string | { delay: number } | { hang: true };

/**
 * A ReadableStream that emits `parts` in order: strings become chunks, {delay} pauses,
 * {hang: true} never continues (for timeout tests). If `signal` aborts, the stream errors with the
 * abort reason, which is what real fetch() does to a response body.
 */
export function bodyStream(parts: Part[], signal?: AbortSignal): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        controller.error(signal.reason);
      });
    },
    async pull(controller) {
      for (;;) {
        const p = parts[i++];
        if (p === undefined) {
          controller.close();
          return;
        }
        if (typeof p === "string") {
          controller.enqueue(enc.encode(p));
          return;
        }
        if ("hang" in p) return new Promise<void>(() => undefined);
        await sleep(p.delay);
      }
    },
  });
}
