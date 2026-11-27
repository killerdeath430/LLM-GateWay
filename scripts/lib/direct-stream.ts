/**
 * Direct (no gateway) *streaming* calls to each provider, with latency marks.
 * Callers: the Unit 0.4 baseline runner, and Unit 1.8, which interleaves these direct calls
 * with gateway calls so both are measured the same way.
 *
 * Same endpoints as scripts/connectivity.ts, switched to streaming:
 *   gemini -> :streamGenerateContent?alt=sse (SSE)   groq -> chat/completions stream:true (SSE)
 *   ollama -> /api/chat stream:true (NDJSON)
 *
 * Timing marks, all measured from t0 = immediately before fetch():
 *   ttfbMs  first byte of the response *body* (headers alone don't count).
 *   ttftMs  first non-empty *visible* answer text. Hidden reasoning (Groq `delta.reasoning`,
 *           Gemini parts with `thought: true`) is excluded, so for reasoning models
 *           ttftMs - ttfbMs approximates hidden thinking time.
 *   totalMs stream finished: Groq `[DONE]`, Ollama `done: true`, Gemini end of stream.
 *
 * Never throws: every outcome becomes a StreamMeasurement so a long run keeps going and
 * failures are recorded, not dropped. Error messages pass through redact() so a provider
 * key can't end up in results/*.jsonl.
 */
import { parseNDJSON, parseSSE, StreamParseError } from "../../src/lib/stream-parsers.js";

export type Provider = "gemini" | "groq" | "ollama";
export const PROVIDERS: readonly Provider[] = ["gemini", "groq", "ollama"];

export interface ChatPrompt {
  messages: { role: "user"; content: string }[];
  maxTokens: number;
  temperature: number;
}

export interface DirectConfig {
  models: Record<Provider, string>;
  geminiApiKey: string | undefined;
  groqApiKey: string | undefined;
  ollamaBaseUrl: string;
  /** Keeps the Ollama model in memory between calls so runs aren't dominated by load time. */
  ollamaKeepAlive: string;
  timeoutMs: number;
}

export type ErrorKind = "config" | "http" | "timeout" | "network" | "bad_stream" | "unknown";

export interface StreamMeasurement {
  provider: Provider;
  requestedModel: string;
  ok: boolean;
  httpStatus: number | null;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  ttfbMs: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  answeringModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  answerChars: number;
}

/** Fields filled in while a stream is consumed. */
interface Acc {
  answeringModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  answerChars: number;
}

/** A provider's stream broke its own protocol (missing terminator, error event, ...). */
class BadStreamError extends Error {}

type Consumer = (
  chunks: AsyncIterable<Uint8Array>,
  onText: (text: string) => void,
  acc: Acc,
) => Promise<void>;

export function redact(s: string, secrets: readonly (string | undefined)[]): string {
  let out = s;
  for (const k of secrets) if (k) out = out.replaceAll(k, "***");
  return out.replace(/\b(AIza[\w-]{20,}|gsk_\w{20,})/g, "***");
}

async function measure(
  provider: Provider,
  requestedModel: string,
  req: { url: string; headers: Record<string, string>; body: unknown },
  consume: Consumer,
  cfg: DirectConfig,
): Promise<StreamMeasurement> {
  const acc: Acc = {
    answeringModel: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    finishReason: null,
    answerChars: 0,
  };
  let httpStatus: number | null = null;
  let ttfbMs: number | null = null;
  let ttftMs: number | null = null;

  const t0 = performance.now();
  const since = () => performance.now() - t0;
  const done = (
    ok: boolean,
    errorKind: ErrorKind | null,
    errorMessage: string | null,
  ): StreamMeasurement => ({
    provider,
    requestedModel,
    ok,
    httpStatus,
    errorKind,
    errorMessage:
      errorMessage === null ? null : redact(errorMessage, [cfg.geminiApiKey, cfg.groqApiKey]),
    ttfbMs,
    ttftMs,
    totalMs: since(),
    ...acc,
  });

  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    httpStatus = res.status;
    if (!res.ok || res.body === null) {
      const text = await res.text();
      return done(false, "http", `HTTP ${String(res.status)}: ${text.slice(0, 500)}`);
    }

    const body = res.body;
    // Pass-through wrapper whose only job is to timestamp the first body byte.
    async function* timed(): AsyncGenerator<Uint8Array> {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        if (ttfbMs === null && chunk.byteLength > 0) ttfbMs = since();
        yield chunk;
      }
    }
    const onText = (text: string) => {
      if (text.length === 0) return;
      ttftMs ??= since();
      acc.answerChars += text.length;
    };

    await consume(timed(), onText, acc);
    return done(true, null, null);
  } catch (err) {
    if (err instanceof BadStreamError || err instanceof StreamParseError) {
      return done(false, "bad_stream", err.message);
    }
    if (err instanceof SyntaxError)
      return done(false, "bad_stream", `invalid JSON: ${err.message}`);
    if (err instanceof Error && err.name === "TimeoutError") {
      return done(false, "timeout", `timed out after ${String(cfg.timeoutMs)} ms`);
    }
    // fetch() throws TypeError("fetch failed") for DNS, refused connections, resets.
    if (err instanceof TypeError) return done(false, "network", err.message);
    return done(false, "unknown", err instanceof Error ? err.message : String(err));
  }
}

// --- Gemini --------------------------------------------------------------------------------

interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
  error?: { message?: string };
}

const consumeGemini: Consumer = async (chunks, onText, acc) => {
  for await (const data of parseSSE(chunks)) {
    const j = JSON.parse(data) as GeminiChunk;
    if (j.error) throw new BadStreamError(`error event in stream: ${j.error.message ?? "?"}`);
    const cand = j.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (part.thought !== true && part.text) onText(part.text);
    }
    if (cand?.finishReason) acc.finishReason = cand.finishReason;
    // Each chunk may repeat usage; the last one seen is the final count.
    if (j.usageMetadata) {
      acc.inputTokens = j.usageMetadata.promptTokenCount ?? acc.inputTokens;
      acc.outputTokens = j.usageMetadata.candidatesTokenCount ?? acc.outputTokens;
      acc.reasoningTokens = j.usageMetadata.thoughtsTokenCount ?? acc.reasoningTokens;
    }
    if (j.modelVersion) acc.answeringModel = j.modelVersion;
  }
  // Gemini has no [DONE] marker; a finishReason is the only sign the answer is complete.
  if (acc.finishReason === null) throw new BadStreamError("stream ended without a finishReason");
};

// --- Groq ----------------------------------------------------------------------------------

interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface GroqChunk {
  model?: string;
  choices?: {
    delta?: { content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: GroqUsage | null;
  x_groq?: { usage?: GroqUsage };
  error?: { message?: string };
}

const consumeGroq: Consumer = async (chunks, onText, acc) => {
  let sawDone = false;
  for await (const data of parseSSE(chunks)) {
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    const j = JSON.parse(data) as GroqChunk;
    if (j.error) throw new BadStreamError(`error event in stream: ${j.error.message ?? "?"}`);
    const choice = j.choices?.[0];
    // delta.reasoning (gpt-oss hidden thinking) is deliberately not passed to onText.
    if (choice?.delta?.content) onText(choice.delta.content);
    if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
    // OpenAI style puts usage on the last chunk (stream_options.include_usage); Groq has also
    // been seen to put it under x_groq. Accept either.
    const usage = j.usage ?? j.x_groq?.usage;
    if (usage) {
      acc.inputTokens = usage.prompt_tokens ?? acc.inputTokens;
      acc.outputTokens = usage.completion_tokens ?? acc.outputTokens;
      acc.reasoningTokens =
        usage.completion_tokens_details?.reasoning_tokens ?? acc.reasoningTokens;
    }
    if (j.model) acc.answeringModel = j.model;
  }
  if (!sawDone) throw new BadStreamError("stream ended without [DONE]");
};

// --- Ollama --------------------------------------------------------------------------------

interface OllamaChunk {
  model?: string;
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const consumeOllama: Consumer = async (chunks, onText, acc) => {
  let sawDone = false;
  for await (const obj of parseNDJSON(chunks)) {
    const j = obj as OllamaChunk;
    if (j.error) throw new BadStreamError(`error in stream: ${j.error}`);
    if (j.message?.content) onText(j.message.content);
    if (j.model) acc.answeringModel = j.model;
    if (j.done === true) {
      sawDone = true;
      acc.inputTokens = j.prompt_eval_count ?? null;
      acc.outputTokens = j.eval_count ?? null;
      acc.finishReason = j.done_reason ?? null;
    }
  }
  if (!sawDone) throw new BadStreamError("stream ended without done: true");
};

// --- entry point ---------------------------------------------------------------------------

function configError(provider: Provider, model: string, message: string): StreamMeasurement {
  return {
    provider,
    requestedModel: model,
    ok: false,
    httpStatus: null,
    errorKind: "config",
    errorMessage: message,
    ttfbMs: null,
    ttftMs: null,
    totalMs: null,
    answeringModel: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    finishReason: null,
    answerChars: 0,
  };
}

/** One streaming call to `provider` with `prompt`. Never throws. */
export async function streamDirect(
  provider: Provider,
  prompt: ChatPrompt,
  cfg: DirectConfig,
): Promise<StreamMeasurement> {
  const model = cfg.models[provider];
  switch (provider) {
    case "gemini": {
      if (!cfg.geminiApiKey) return configError(provider, model, "GEMINI_API_KEY is not set");
      return measure(
        provider,
        model,
        {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          headers: { "x-goog-api-key": cfg.geminiApiKey },
          body: {
            contents: prompt.messages.map((m) => ({ role: "user", parts: [{ text: m.content }] })),
            generationConfig: {
              temperature: prompt.temperature,
              maxOutputTokens: prompt.maxTokens,
            },
          },
        },
        consumeGemini,
        cfg,
      );
    }
    case "groq": {
      if (!cfg.groqApiKey) return configError(provider, model, "GROQ_API_KEY is not set");
      return measure(
        provider,
        model,
        {
          url: "https://api.groq.com/openai/v1/chat/completions",
          headers: { authorization: `Bearer ${cfg.groqApiKey}` },
          body: {
            model,
            messages: prompt.messages,
            temperature: prompt.temperature,
            max_tokens: prompt.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
          },
        },
        consumeGroq,
        cfg,
      );
    }
    case "ollama":
      return measure(
        provider,
        model,
        {
          url: `${cfg.ollamaBaseUrl}/api/chat`,
          headers: {},
          body: {
            model,
            messages: prompt.messages,
            stream: true,
            keep_alive: cfg.ollamaKeepAlive,
            options: { temperature: prompt.temperature, num_predict: prompt.maxTokens },
          },
        },
        consumeOllama,
        cfg,
      );
  }
}
