import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  const app = buildServer();
  afterAll(() => app.close());

  it("returns 200 with status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});
