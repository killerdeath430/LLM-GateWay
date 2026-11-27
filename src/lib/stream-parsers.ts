/**
 * Incremental parsers for the two streaming formats our providers use:
 *   - SSE (Server-Sent Events): Gemini `?alt=sse` and Groq `stream: true`.
 *   - NDJSON (one JSON object per line): Ollama `stream: true`.
 *
 * Both take raw byte chunks exactly as they arrive from fetch(). Network chunk boundaries are
 * arbitrary: a chunk can end mid-line, mid-UTF-8 character, or between the \r and \n of a CRLF,
 * so both parsers buffer until a full line is available.
 *
 * Callers: scripts/lib/direct-stream.ts (baseline, Unit 0.4); the gateway's streaming
 * adapters will reuse them in Unit 1.6.
 */

/** Thrown when a stream's bytes can't be parsed (e.g. an NDJSON line that isn't JSON). */
export class StreamParseError extends Error {
  override name = "StreamParseError";
}

/**
 * Splits buffered text into complete lines. Accepts \n, \r\n and lone \r as line endings
 * (the SSE spec allows all three). A trailing \r is held back because its \n may be the first
 * byte of the next chunk; `final` releases it at end of stream.
 */
function takeLines(buf: string, final: boolean): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  for (;;) {
    const i = rest.search(/[\r\n]/);
    if (i === -1) break;
    const isCR = rest[i] === "\r";
    if (isCR && i === rest.length - 1 && !final) break; // maybe half of a CRLF
    lines.push(rest.slice(0, i));
    rest = rest.slice(i + (isCR && rest[i + 1] === "\n" ? 2 : 1));
  }
  return { lines, rest };
}

/**
 * Yields the `data` payload of each SSE event (multiple `data:` lines joined with "\n").
 * Follows the WHATWG event-stream rules we need: a blank line dispatches the event, lines
 * starting with ":" are comments, other fields (event, id, retry) are ignored, one leading
 * space after the colon is stripped, and an event cut off by end-of-stream (no blank line
 * after it) is discarded rather than dispatched.
 *
 * It does not interpret payloads: the caller decides what "[DONE]" or JSON means.
 */
export async function* parseSSE(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder(); // stream mode keeps split UTF-8 characters intact
  let buf = "";
  let data: string[] = [];

  function* handle(lines: string[]): Generator<string> {
    for (const line of lines) {
      if (line === "") {
        if (data.length > 0) yield data.join("\n");
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
    }
  }

  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    const { lines, rest } = takeLines(buf, false);
    buf = rest;
    yield* handle(lines);
  }
  buf += decoder.decode();
  yield* handle(takeLines(buf, true).lines);
  // Whatever is left in `data` belongs to an unterminated event: discarded per the spec.
}

/**
 * Yields one parsed JSON value per non-blank line. A final line without a trailing newline
 * is still parsed (Ollama ends its stream right after the last object).
 */
export async function* parseNDJSON(chunks: AsyncIterable<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder();
  let buf = "";

  function parseLine(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      throw new StreamParseError(`invalid NDJSON line: ${line.slice(0, 120)}`);
    }
  }

  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    const { lines, rest } = takeLines(buf, false);
    buf = rest;
    for (const line of lines) if (line.trim() !== "") yield parseLine(line);
  }
  buf += decoder.decode();
  const { lines, rest } = takeLines(buf, true);
  for (const line of [...lines, rest]) if (line.trim() !== "") yield parseLine(line);
}
