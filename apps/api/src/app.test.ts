import { createLogger } from "@rfl-bot/core";
import { describe, expect, it } from "vitest";
import { type AppDeps, buildApp } from "./app";

const logger = createLogger({ name: "test", level: "silent" });
const NOW = Date.parse("2026-10-26T12:00:00Z");

function app(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    logger,
    version: "abc123",
    checks: { database: async () => {}, redis: async () => "PONG" },
    workerHeartbeat: async () => new Date(NOW - 10_000).toISOString(),
    now: () => NOW,
    ...overrides,
  });
}

describe("GET /health", () => {
  it("responde ok com a versão", async () => {
    const response = await app().inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", version: "abc123" });
  });
});

describe("GET /ready", () => {
  it("responde 200 quando banco e Redis respondem", async () => {
    const response = await app().inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      checks: { database: { ok: true }, redis: { ok: true } },
      worker: { stale: false },
    });
  });

  it("responde 503 e explica qual dependência falhou", async () => {
    const response = await app({
      checks: {
        database: async () => {
          throw new Error("conexão recusada");
        },
        redis: async () => "PONG",
      },
    }).inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "error",
      checks: { database: { ok: false, error: "conexão recusada" }, redis: { ok: true } },
    });
  });

  it("responde 503 quando uma dependência demora demais", async () => {
    const response = await app({
      checkTimeoutMs: 20,
      checks: { database: () => new Promise(() => {}) },
    }).inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().checks.database.error).toMatch(/sem resposta/);
  });

  it("marca o worker como parado sem batimento recente, sem derrubar a API", async () => {
    const response = await app({
      workerHeartbeat: async () => new Date(NOW - 10 * 60_000).toISOString(),
    }).inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json().worker.stale).toBe(true);
  });

  it("marca o worker como parado quando ele nunca bateu", async () => {
    const response = await app({ workerHeartbeat: async () => null }).inject({
      method: "GET",
      url: "/ready",
    });
    expect(response.json().worker).toEqual({ lastHeartbeatAt: null, stale: true });
  });
});
