import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeEvent } from "@rfl-bot/contracts";
import { createLogger } from "@rfl-bot/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/drivers/types";
import { createEchoRuntime, type ProviderRuntime } from "../src/providers";
import { buildRunnerServer } from "../src/server";

const TOKEN = "t".repeat(40);
const logger = createLogger({ name: "test", level: "silent" });
const auth = { authorization: `Bearer ${TOKEN}` };

const turn = (overrides: Record<string, unknown> = {}) => ({
  turnId: "cm1turn0000000001",
  botId: "cm1bot00000000001",
  provider: "echo",
  model: "eco",
  instructions: "",
  session: { id: "0f8fad5b-d9cb-469f-a165-70867728950e", resume: false },
  input: "oi",
  ...overrides,
});

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function server(runtimes: ProviderRuntime[] = [createEchoRuntime()], maxConcurrentTurns = 2) {
  const workspaces: string[] = [];
  const app = buildRunnerServer({
    logger,
    token: TOKEN,
    runtimes,
    maxConcurrentTurns,
    workspace: async (botId) => {
      workspaces.push(botId);
      return `/tmp/${botId}`;
    },
    cliEnv: { HOME: "/tmp" },
  });
  servers.push(app);
  return { app, workspaces };
}

function lines(body: string): RuntimeEvent[] {
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}

/** Driver lento que avisa quando foi cancelado. */
function slowRuntime(onAbort: () => void): ProviderRuntime {
  const driver: Driver = {
    id: "echo",
    async *runTurn({ signal }) {
      signal.addEventListener("abort", onAbort);
      await sleep(5000, undefined, { signal }).catch(() => {});
      yield { type: "turn.failed", error: "cancelado", code: "interrupted" };
    },
  };
  return { ...createEchoRuntime(), driver };
}

describe("runner", () => {
  it("/health não pede token", async () => {
    const response = await server().app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("as outras rotas exigem o token", async () => {
    const { app } = server();
    expect((await app.inject({ method: "GET", url: "/providers" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/providers",
          headers: { authorization: "Bearer errado" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "GET", url: "/providers", headers: auth })).statusCode).toBe(
      200,
    );
  });

  it("executa um turno e devolve eventos em JSON por linha", async () => {
    const { app, workspaces } = server();
    const response = await app.inject({
      method: "POST",
      url: "/turns",
      headers: auth,
      payload: turn(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/x-ndjson/);
    expect(lines(response.body).at(-1)).toEqual({ type: "turn.completed", finalText: "Eco: oi" });
    expect(workspaces).toEqual(["cm1bot00000000001"]);
  });

  it("recusa pedido inválido e provedor desligado", async () => {
    const { app } = server();
    const invalid = await app.inject({
      method: "POST",
      url: "/turns",
      headers: auth,
      payload: turn({ botId: "../x" }),
    });
    expect(invalid.statusCode).toBe(400);

    const off = await app.inject({
      method: "POST",
      url: "/turns",
      headers: auth,
      payload: turn({ provider: "claude" }),
    });
    expect(off.statusCode).toBe(404);
  });

  it("avisa quando está ocupado", async () => {
    const { app } = server([slowRuntime(() => {})], 1);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/turns`;
    const headers = { ...auth, "content-type": "application/json" };

    const first = new AbortController();
    const running = fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(turn()),
      signal: first.signal,
    });
    await sleep(100);
    const busy = await fetch(url, { method: "POST", headers, body: JSON.stringify(turn()) });
    expect(busy.status).toBe(429);
    first.abort();
    await running.catch(() => {});
  });

  it("cancela o turno quando quem chamou desiste", async () => {
    let aborted = false;
    const { app } = server([
      slowRuntime(() => {
        aborted = true;
      }),
    ]);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/turns`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(turn()),
      signal: controller.signal,
    });
    await sleep(100);
    controller.abort();
    await request.catch(() => {});
    await sleep(100);

    expect(aborted).toBe(true);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().activeTurns).toBe(0);
  });
});
