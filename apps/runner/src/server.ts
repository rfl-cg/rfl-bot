import { timingSafeEqual } from "node:crypto";
import {
  loginCodeRequestSchema,
  type ProviderId,
  providerIdSchema,
  type RuntimeEvent,
  turnRequestSchema,
} from "@rfl-bot/contracts";
import type { Logger } from "@rfl-bot/core";
import Fastify from "fastify";
import type { ProviderRuntime } from "./providers";

export type RunnerServerDeps = {
  logger: Logger;
  token: string;
  runtimes: ProviderRuntime[];
  maxConcurrentTurns: number;
  /** Cria (se preciso) e devolve a pasta do bot. */
  workspace: (botId: string) => Promise<string>;
  /** Ambiente limpo dos CLIs. */
  cliEnv: Record<string, string>;
};

export function buildRunnerServer({
  logger,
  token,
  runtimes,
  maxConcurrentTurns,
  workspace,
  cliEnv,
}: RunnerServerDeps) {
  const app = Fastify({ loggerInstance: logger });
  const byId = new Map<ProviderId, ProviderRuntime>(
    runtimes.map((runtime) => [runtime.id, runtime]),
  );
  const expectedToken = Buffer.from(`Bearer ${token}`);
  let activeTurns = 0;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const received = Buffer.from(request.headers.authorization ?? "");
    if (received.length !== expectedToken.length || !timingSafeEqual(received, expectedToken)) {
      return reply.code(401).send({ error: "não autorizado" });
    }
  });

  const findRuntime = (raw: string) => {
    const parsed = providerIdSchema.safeParse(raw);
    return parsed.success ? byId.get(parsed.data) : undefined;
  };

  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok", activeTurns }));

  app.get("/providers", async () => Promise.all(runtimes.map((runtime) => runtime.status())));

  app.post<{ Params: { id: string } }>("/providers/:id/login", async (request, reply) => {
    const runtime = findRuntime(request.params.id);
    if (!runtime?.startLogin) return reply.code(404).send({ error: "provedor sem login" });
    try {
      return await runtime.startLogin();
    } catch (error) {
      request.log.warn({ provider: runtime.id }, "login não começou");
      return reply.code(502).send({ error: error instanceof Error ? error.message : "falhou" });
    }
  });

  app.post<{ Params: { id: string; loginId: string } }>(
    "/providers/:id/login/:loginId/code",
    async (request, reply) => {
      const runtime = findRuntime(request.params.id);
      if (!runtime?.submitLoginCode) return reply.code(404).send({ error: "provedor sem login" });
      const body = loginCodeRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "código inválido" });
      return runtime.submitLoginCode(request.params.loginId, body.data.code);
    },
  );

  app.post("/turns", async (request, reply) => {
    const parsed = turnRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "pedido inválido" });
    const turn = parsed.data;
    const runtime = byId.get(turn.provider);
    if (!runtime) return reply.code(404).send({ error: `provedor ${turn.provider} desligado` });
    if (activeTurns >= maxConcurrentTurns) {
      return reply.code(429).send({ error: "runner ocupado", code: "runner_busy" });
    }

    activeTurns += 1;
    const log = request.log.child({
      turnId: turn.turnId,
      botId: turn.botId,
      provider: turn.provider,
    });
    const abort = new AbortController();
    // A resposta fecha antes do fim = o worker cancelou ou caiu.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    const write = (event: RuntimeEvent) => reply.raw.write(`${JSON.stringify(event)}\n`);

    try {
      const cwd = await workspace(turn.botId);
      log.info("turno começou");
      for await (const event of runtime.driver.runTurn({
        cwd,
        model: turn.model,
        ...(turn.effort ? { effort: turn.effort } : {}),
        instructions: turn.instructions,
        session: turn.session,
        input: turn.input,
        env: cliEnv,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        write(event);
        if (event.type === "turn.failed") log.warn({ code: event.code }, "turno falhou");
      }
      log.info({ aborted: abort.signal.aborted }, "turno terminou");
    } catch (error) {
      log.error({ err: error }, "erro no turno");
      write({ type: "turn.failed", error: "erro interno no runner", code: "internal" });
    } finally {
      activeTurns -= 1;
      reply.raw.end();
    }
  });

  return app;
}
