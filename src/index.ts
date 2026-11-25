import { buildServer } from "./server.js";

// Process entry point: `npm run dev` (tsx) or `npm start` (compiled dist/).
// Binds to 127.0.0.1 by default so the gateway is not exposed on the LAN by accident.
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildServer({ logger: true });

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
