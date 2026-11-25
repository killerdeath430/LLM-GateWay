import Fastify, { type FastifyInstance } from "fastify";

/**
 * Builds the Fastify app without starting to listen.
 *
 * Why a factory: tests call buildServer() and use app.inject() to send in-process
 * requests (no open port, no network), and src/index.ts calls it to run the real server.
 * Later units register routes (/v1/chat/completions, /v1/models) and the auth hook here.
 */
export function buildServer(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  // Liveness only: says the process is up. It does not check providers or Postgres.
  app.get("/health", () => ({ status: "ok" }));

  return app;
}
