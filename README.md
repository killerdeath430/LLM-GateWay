# llm-gateway

An OpenAI-compatible LLM gateway in front of Gemini, Groq and Ollama, with model-alias routing, client API keys, streaming, and per-request logging of tokens, latency and cost.

> **Status: Phase 0, Unit 0.1 (repo skeleton).** Only `GET /health` exists so far. See `docs/handover.md`.

## Status

| Phase | Scope                                                                                                    | State                               |
| ----- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 0     | Setup, Postgres, connectivity, direct latency baseline                                                   | In progress (0.1 done)              |
| 1     | `/v1/chat/completions` (stream and non-stream), aliases, client keys, logging and cost, gateway overhead | Not started                         |
| 2+    | Retries, failover, rate limiting, caching, evals, dashboards, deployment                                 | Future work, not in this engagement |

## Quick start

Requires Node 24+ and npm.

```bash
npm ci
cp .env.example .env    # fill in provider keys (never commit .env)
npm run dev             # http://127.0.0.1:8080/health
```

| Script              | What it does                        |
| ------------------- | ----------------------------------- |
| `npm run build`     | Compile `src/` to `dist/`           |
| `npm run typecheck` | Type-check src, tests and scripts   |
| `npm run lint`      | ESLint plus a Prettier check        |
| `npm test`          | Vitest (never calls real providers) |

## Results

Latency numbers will appear in `docs/baseline.md`, each traceable to a file in `results/`. Currently: TODO(measure).

## Limitations

- Latency was measured from one machine and network at single concurrency. This is a baseline, not a load test, and provider latency varies by time of day.
- Some token counts may be estimated where a provider does not report usage while streaming (marked `token_source = estimated`).
- Ollama latency depends on local hardware and is not comparable to the hosted providers.
- Free-tier rate limits may affect the measurements.
- No reliability features yet: retries, failover, rate limiting and caching are Phase 2+ work.

## Docs

`docs/decisions.md` (why), `docs/architecture.md` (what), `docs/flow.md` (call paths), `docs/constraints.md` (rules), `docs/test-checklist.md` (how each unit is verified).
