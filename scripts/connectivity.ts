/**
 * Unit 0.3: one direct (no gateway) call to each provider with a fixed prompt.
 * Usage: `npm run connectivity` (add `-- --raw` to also print each raw response body).
 *
 * Purpose: prove each key/model/endpoint works and expose the raw response shapes that the
 * Phase 1 adapters must normalize.
 *
 * Endpoints are the same ones the adapters will call, so the 0.4 direct
 * baseline and the 1.8 gateway run measure the same upstream path:
 *   gemini -> native generateContent      groq -> OpenAI-compatible chat/completions
 *   ollama -> native /api/chat
 *
 * Exit code 0 only if all three calls succeed. A missing key skips that provider with a
 * clear message (exit 1), never a stack trace. Provider keys are never printed: they are sent
 * only in headers (never in URLs), and every printed string passes through redact().
 */

// Models chosen on 2026-11-26. Phase 1 moves these into config/models.yaml.
// Gemini alternatives tried first: gemini-2.5-flash (404, not available to new users),
// gemini-3.8-flash (repeated 503 "high demand"), gemini-3.5-flash (answered as
// gemini-3.6-flash, i.e. silently redirected, so unsuitable for a frozen baseline).
const MODELS = {
  gemini: "gemini-3.1-flash-lite",
  groq: "openai/gpt-oss-20b",
  ollama: "qwen2.5-coder:7b",
} as const;

const PROMPT = "In one short sentence, what is an API gateway?";
// Generous cap: Gemini 2.5 Flash and gpt-oss spend part of the budget on hidden reasoning
// tokens before the visible answer, so a small cap can return an empty answer.
const MAX_OUTPUT_TOKENS = 512;
const TIMEOUT_MS = 30_000;
const RAW = process.argv.includes("--raw");

type Provider = keyof typeof MODELS;

interface CallResult {
  model: string; // model name as reported by the provider, not as requested
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  reasoningTokens: number | undefined; // hidden "thinking" tokens, if the provider reports them
  text: string;
  raw: unknown;
}

/** Masks the configured key values and anything key-shaped, so nothing printed can leak one. */
function redact(s: string): string {
  let out = s;
  for (const k of [process.env.GEMINI_API_KEY, process.env.GROQ_API_KEY]) {
    if (k) out = out.replaceAll(k, "***");
  }
  return out.replace(/\b(AIza[\w-]{20,}|gsk_\w{20,})/g, "***");
}

class ConfigError extends Error {}

/** POST JSON with a timeout; throws a readable Error on non-2xx (body included, redacted). */
async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

function requireKey(name: "GEMINI_API_KEY" | "GROQ_API_KEY"): string {
  const key = process.env[name];
  if (!key) throw new ConfigError(`${name} is not set in .env`);
  return key;
}

// --- per-provider calls: request shape and response field paths differ for each -----------

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

async function callGemini(): Promise<CallResult> {
  const key = requireKey("GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`;
  const raw = (await postJson(
    url,
    { "x-goog-api-key": key }, // header, not ?key= in the URL, so errors can't echo it
    {
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
  )) as GeminiResponse;
  const parts = raw.candidates?.[0]?.content?.parts ?? [];
  return {
    model: raw.modelVersion ?? "(not reported)",
    inputTokens: raw.usageMetadata?.promptTokenCount,
    outputTokens: raw.usageMetadata?.candidatesTokenCount,
    reasoningTokens: raw.usageMetadata?.thoughtsTokenCount,
    text: parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join(""),
    raw,
  };
}

interface GroqResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

async function callGroq(): Promise<CallResult> {
  const key = requireKey("GROQ_API_KEY");
  const raw = (await postJson(
    "https://api.groq.com/openai/v1/chat/completions",
    { authorization: `Bearer ${key}` },
    {
      model: MODELS.groq,
      messages: [{ role: "user", content: PROMPT }],
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
    },
  )) as GroqResponse;
  return {
    model: raw.model ?? "(not reported)",
    inputTokens: raw.usage?.prompt_tokens,
    outputTokens: raw.usage?.completion_tokens,
    reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens,
    text: raw.choices?.[0]?.message?.content ?? "",
    raw,
  };
}

interface OllamaResponse {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

async function callOllama(): Promise<CallResult> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  let raw: OllamaResponse;
  try {
    raw = (await postJson(
      `${base}/api/chat`,
      {},
      {
        model: MODELS.ollama,
        messages: [{ role: "user", content: PROMPT }],
        stream: false,
        options: { temperature: 0, num_predict: MAX_OUTPUT_TOKENS },
      },
    )) as OllamaResponse;
  } catch (err) {
    // fetch throws TypeError("fetch failed") when nothing listens on the port.
    if (err instanceof TypeError) {
      throw new ConfigError(`cannot reach Ollama at ${base}. Is it running? (ollama serve)`);
    }
    throw err;
  }
  return {
    model: raw.model ?? "(not reported)",
    inputTokens: raw.prompt_eval_count,
    outputTokens: raw.eval_count,
    reasoningTokens: undefined,
    text: raw.message?.content ?? "",
    raw,
  };
}

// --- runner ---------------------------------------------------------------------------------

const CALLS: Record<Provider, () => Promise<CallResult>> = {
  gemini: callGemini,
  groq: callGroq,
  ollama: callOllama,
};

function describeError(err: unknown): string {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") {
    return `timed out after ${String(TIMEOUT_MS)} ms`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  console.log(`prompt: "${PROMPT}"  (temperature 0, max ${String(MAX_OUTPUT_TOKENS)} tokens)\n`);
  let ok = 0;
  for (const provider of Object.keys(CALLS) as Provider[]) {
    const start = performance.now();
    try {
      const r = await CALLS[provider]();
      const ms = performance.now() - start;
      ok++;
      const reasoning =
        r.reasoningTokens === undefined ? "" : ` reasoning=${String(r.reasoningTokens)}`;
      console.log(
        `OK   ${provider.padEnd(6)} model=${r.model} in=${String(r.inputTokens)} out=${String(r.outputTokens)}${reasoning} latency=${ms.toFixed(0)}ms`,
      );
      console.log(`     reply: ${redact(r.text.replace(/\s+/g, " ").trim().slice(0, 80))}`);
      if (RAW) console.log(`     raw: ${redact(JSON.stringify(r.raw))}`);
    } catch (err) {
      const label = err instanceof ConfigError ? "SKIP" : "FAIL";
      console.log(`${label} ${provider.padEnd(6)} ${redact(describeError(err))}`);
    }
  }
  const total = Object.keys(CALLS).length;
  console.log(`\n${String(ok)}/${String(total)} providers OK`);
  if (ok !== total) process.exitCode = 1;
}

await main();
