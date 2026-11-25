# llm-gateway

An OpenAI-compatible LLM gateway in front of Gemini, Groq and Ollama, with model-alias routing, client API keys, streaming, and per-request logging of tokens, latency and cost.

> **Status: Phase 0, Unit 0.3.** `GET /health`, the Postgres schema, and a direct connectivity check for all three providers exist so far.

## Status

| Phase | Scope                                                                                                    | State                               |
| ----- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 0     | Setup, Postgres, connectivity, direct latency baseline                                                   | In progress (0.1–0.3 done)          |
| 1     | `/v1/chat/completions` (stream and non-stream), aliases, client keys, logging and cost, gateway overhead | Not started                         |
| 2+    | Retries, failover, rate limiting, caching, evals, dashboards, deployment                                 | Future work, not in this engagement |

## Quick start

Requires Node 24+, npm, and Docker.

```bash
npm ci
cp .env.example .env    # fill in provider keys (never commit .env)
docker compose up -d    # Postgres on 127.0.0.1:5433
npm run migrate         # creates api_keys and request_logs; safe to re-run
npm run dev             # http://127.0.0.1:8080/health
```

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run build`        | Compile `src/` to `dist/`                                           |
| `npm run typecheck`    | Type-check src, tests and scripts                                   |
| `npm run lint`         | ESLint plus a Prettier check                                        |
| `npm test`             | Vitest (never calls real providers)                                 |
| `npm run migrate`      | Apply pending SQL migrations                                        |
| `npm run connectivity` | One direct call to each provider (2 free-tier calls + local Ollama) |

## Providers

| Provider | Endpoint                             | Model                   |
| -------- | ------------------------------------ | ----------------------- |
| Gemini   | native `generateContent`             | `gemini-3.1-flash-lite` |
| Groq     | OpenAI-compatible `chat/completions` | `openai/gpt-oss-20b`    |
| Ollama   | native `/api/chat` (local)           | `qwen2.5-coder:7b`      |

## Results

The direct vs gateway latency table (p50/p95 TTFB and total latency) will go here. Each number will list the command that produced it and link to its raw file in `results/`. Currently: TODO(measure).

## Limitations

- Latency was measured from one machine and network at single concurrency. This is a baseline, not a load test, and provider latency varies by time of day.
- Some token counts may be estimated where a provider does not report usage while streaming (marked `token_source = estimated`).
- Ollama latency depends on local hardware and is not comparable to the hosted providers.
- Free-tier rate limits may affect the measurements.
- No reliability features yet: retries, failover, rate limiting and caching are Phase 2+ work.
