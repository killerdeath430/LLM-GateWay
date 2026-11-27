import { describe, expect, it } from "vitest";
import { parseNDJSON, parseSSE, StreamParseError } from "../src/lib/stream-parsers.js";
import { byteByByte, chunksOf, collect } from "./helpers/streams.js";

describe("parseSSE", () => {
  it("yields the data of each event", async () => {
    const events = await collect(parseSSE(chunksOf('data: {"a":1}\n\ndata: [DONE]\n\n')));
    expect(events).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles CRLF line endings (Gemini uses them)", async () => {
    const events = await collect(parseSSE(chunksOf("data: one\r\n\r\ndata: two\r\n\r\n")));
    expect(events).toEqual(["one", "two"]);
  });

  it("gives identical results when every byte arrives in its own chunk", async () => {
    const text = 'data: {"x":"héllo ✓"}\r\n\r\n: comment\n\ndata: b\n\n';
    expect(await collect(parseSSE(byteByByte(text)))).toEqual(['{"x":"héllo ✓"}', "b"]);
  });

  it("does not create an extra event when \\r and \\n land in different chunks", async () => {
    const events = await collect(parseSSE(chunksOf("data: a\r", "\n\r", "\n")));
    expect(events).toEqual(["a"]);
  });

  it("joins multiple data lines with newlines and ignores comments and other fields", async () => {
    const text = ": keep-alive\nevent: message\nid: 7\ndata: line1\ndata: line2\n\n";
    expect(await collect(parseSSE(chunksOf(text)))).toEqual(["line1\nline2"]);
  });

  it("strips exactly one space after the colon", async () => {
    expect(await collect(parseSSE(chunksOf("data:  two spaces\n\ndata:none\n\n")))).toEqual([
      " two spaces",
      "none",
    ]);
  });

  it("discards an event cut off by the end of the stream", async () => {
    expect(await collect(parseSSE(chunksOf("data: complete\n\ndata: cut off")))).toEqual([
      "complete",
    ]);
  });
});

describe("parseNDJSON", () => {
  it("parses one object per line, including a last line with no newline", async () => {
    const out = await collect(parseNDJSON(chunksOf('{"a":1}\n{"b":', '2}\n{"c":3}')));
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("skips blank lines and handles CRLF and byte-by-byte delivery", async () => {
    const out = await collect(parseNDJSON(byteByByte('{"a":"é"}\r\n\r\n{"b":2}\r\n')));
    expect(out).toEqual([{ a: "é" }, { b: 2 }]);
  });

  it("throws StreamParseError on a line that is not JSON", async () => {
    await expect(collect(parseNDJSON(chunksOf('{"a":1}\nnot json\n')))).rejects.toThrow(
      StreamParseError,
    );
  });
});
