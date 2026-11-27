/**
 * streamDirect against a mocked fetch (decision: tests never call real providers).
 * Stream bodies are hand-written in each provider's documented/observed format.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DirectConfig, streamDirect } from "../scripts/lib/direct-stream.js";
import { bodyStream, type Part } from "./helpers/streams.js";

const cfg: DirectConfig = {
  models: { gemini: "g-model", groq: "q-model", ollama: "o-model" },
  geminiApiKey: "GEMINI-SECRET-123",
  groqApiKey: "GROQ-SECRET-456",
  ollamaBaseUrl: "http://ollama.test",
  ollamaKeepAlive: "30m",
  timeoutMs: 2000,
};
const prompt = {
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 64,
  temperature: 0,
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Replaces global fetch with one that records the request and streams `parts` back. */
function mockFetch(parts: Part[], status = 200): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
      });
      const signal = init.signal ?? undefined;
      return Promise.resolve(new Response(bodyStream(parts, signal), { status }));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("groq", () => {
  const reasoning = { choices: [{ delta: { reasoning: "thinking..." } }] };
  const content = (t: string) => ({ model: "q-model", choices: [{ delta: { content: t } }] });
  const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };
  const usage = {
    choices: [],
    usage: {
      prompt_tokens: 80,
      completion_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 20 },
    },
  };

  it("measures ttfb/ttft, excludes reasoning from ttft, and reads usage", async () => {
    const calls = mockFetch([
      sse(reasoning),
      { delay: 60 }, // hidden thinking time before the first visible token
      sse(content("Hello")),
      sse(content(" world")),
      sse(finish),
      sse(usage),
      "data: [DONE]\n\n",
    ]);
    const m = await streamDirect("groq", prompt, cfg);

    expect(m.ok).toBe(true);
    expect(m.answeringModel).toBe("q-model");
    expect([m.inputTokens, m.outputTokens, m.reasoningTokens]).toEqual([80, 30, 20]);
    expect(m.finishReason).toBe("stop");
    expect(m.answerChars).toBe("Hello world".length);
    // Ordering, plus the reasoning gap shows up between ttfb and ttft.
    expect(m.ttfbMs).not.toBeNull();
    expect(m.ttftMs).not.toBeNull();
    expect(m.ttfbMs ?? 0).toBeLessThanOrEqual(m.ttftMs ?? 0);
    expect(m.ttftMs ?? 0).toBeLessThanOrEqual(m.totalMs ?? 0);
    expect((m.ttftMs ?? 0) - (m.ttfbMs ?? 0)).toBeGreaterThanOrEqual(40);

    const [call] = calls;
    expect(call?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(call?.headers.authorization).toBe("Bearer GROQ-SECRET-456");
    expect(call?.body).toMatchObject({
      model: "q-model",
      stream: true,
      max_tokens: 64,
      temperature: 0,
      stream_options: { include_usage: true },
    });
  });

  it("also accepts usage under x_groq", async () => {
    mockFetch([
      sse(content("ok")),
      sse({ choices: [], x_groq: { usage: { prompt_tokens: 5, completion_tokens: 1 } } }),
      "data: [DONE]\n\n",
    ]);
    const m = await streamDirect("groq", prompt, cfg);
    expect([m.inputTokens, m.outputTokens]).toEqual([5, 1]);
  });

  it("reports bad_stream when [DONE] never arrives", async () => {
    mockFetch([sse(content("partial"))]);
    const m = await streamDirect("groq", prompt, cfg);
    expect(m.ok).toBe(false);
    expect(m.errorKind).toBe("bad_stream");
    expect(m.errorMessage).toMatch(/\[DONE\]/);
  });

  it("reports HTTP errors with status and body, with keys redacted", async () => {
    mockFetch(['{"error":{"message":"rate limited for key GROQ-SECRET-456"}}'], 429);
    const m = await streamDirect("groq", prompt, cfg);
    expect(m.ok).toBe(false);
    expect([m.errorKind, m.httpStatus]).toEqual(["http", 429]);
    expect(m.errorMessage).toContain("rate limited");
    expect(m.errorMessage).not.toContain("GROQ-SECRET-456");
  });
});

describe("gemini", () => {
  const chunk = (parts: object[], extra: object = {}) =>
    sse({
      candidates: [{ content: { role: "model", parts } }],
      modelVersion: "g-model-001",
      ...extra,
    });

  it("skips thought parts, reads final usage, and sends the key only in a header", async () => {
    const calls = mockFetch([
      chunk([{ text: "secret reasoning", thought: true }]),
      chunk([{ text: "Hi" }]),
      sse({
        candidates: [{ content: { parts: [{ text: " there" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 7 },
        modelVersion: "g-model-001",
      }),
    ]);
    const m = await streamDirect("gemini", prompt, cfg);

    expect(m.ok).toBe(true);
    expect(m.answerChars).toBe("Hi there".length);
    expect([m.inputTokens, m.outputTokens, m.reasoningTokens]).toEqual([12, 3, 7]);
    expect(m.finishReason).toBe("STOP");
    expect(m.answeringModel).toBe("g-model-001"); // what answered, not what was requested
    expect(m.requestedModel).toBe("g-model");

    const [call] = calls;
    expect(call?.url).toContain("/models/g-model:streamGenerateContent?alt=sse");
    expect(call?.url).not.toContain("GEMINI-SECRET-123");
    expect(call?.headers["x-goog-api-key"]).toBe("GEMINI-SECRET-123");
    expect(call?.body).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 64 },
    });
  });

  it("reports bad_stream when the stream ends without a finishReason", async () => {
    mockFetch([chunk([{ text: "cut" }])]);
    const m = await streamDirect("gemini", prompt, cfg);
    expect(m.errorKind).toBe("bad_stream");
  });

  it("returns a config error without calling fetch when the key is missing", async () => {
    const calls = mockFetch([]);
    const m = await streamDirect("gemini", prompt, { ...cfg, geminiApiKey: undefined });
    expect([m.ok, m.errorKind]).toEqual([false, "config"]);
    expect(calls).toHaveLength(0);
  });
});

describe("ollama", () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

  it("reads NDJSON, final counts, and sends keep_alive", async () => {
    const calls = mockFetch([
      line({ model: "o-model", message: { role: "assistant", content: "Yo" }, done: false }),
      line({ model: "o-model", message: { role: "assistant", content: "!" }, done: false }),
      line({
        model: "o-model",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 9,
        eval_count: 2,
      }),
    ]);
    const m = await streamDirect("ollama", prompt, cfg);
    expect(m.ok).toBe(true);
    expect([m.inputTokens, m.outputTokens, m.finishReason, m.answerChars]).toEqual([
      9,
      2,
      "stop",
      3,
    ]);
    expect(calls[0]?.url).toBe("http://ollama.test/api/chat");
    expect(calls[0]?.body).toMatchObject({
      stream: true,
      keep_alive: "30m",
      options: { temperature: 0, num_predict: 64 },
    });
  });

  it("reports bad_stream for an error line", async () => {
    mockFetch([line({ error: "model 'o-model' not found" })]);
    const m = await streamDirect("ollama", prompt, cfg);
    expect(m.errorKind).toBe("bad_stream");
    expect(m.errorMessage).toContain("not found");
  });
});

describe("failures common to all providers", () => {
  it("times out a stream that stops sending", async () => {
    mockFetch([line(), { hang: true }]);
    function line() {
      return `${JSON.stringify({ model: "o-model", message: { content: "a" }, done: false })}\n`;
    }
    const m = await streamDirect("ollama", prompt, { ...cfg, timeoutMs: 100 });
    expect([m.ok, m.errorKind]).toEqual([false, "timeout"]);
    expect(m.ttftMs).not.toBeNull(); // it did get a token before stalling
  });

  it("maps a refused connection to network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const m = await streamDirect("ollama", prompt, cfg);
    expect([m.ok, m.errorKind, m.httpStatus]).toEqual([false, "network", null]);
  });
});
