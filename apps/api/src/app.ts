import { type CheckResult, type ReadyResponse, WORKER_STALE_AFTER_MS } from "@rfl-bot/contracts";
import type { Logger } from "@rfl-bot/core";
import Fastify from "fastify";
import { withTimeout } from "./with-timeout";

export type ReadinessCheck = () => Promise<unknown>;

export type AppDeps = {
  logger: Logger;
  version: string;
  /** Dependências que precisam responder para a API estar pronta (banco, Redis). */
  checks: Record<string, ReadinessCheck>;
  /** Data ISO do último batimento do worker, ou null se nunca bateu. */
  workerHeartbeat: () => Promise<string | null>;
  checkTimeoutMs?: number;
  now?: () => number;
};

export function buildApp({
  logger,
  version,
  checks,
  workerHeartbeat,
  checkTimeoutMs = 2000,
  now = Date.now,
}: AppDeps) {
  const app = Fastify({ loggerInstance: logger });

  // Processo vivo. Usado pelo healthcheck do Docker.
  app.get("/health", { logLevel: "warn" }, async () => ({
    status: "ok" as const,
    version,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  // Pronto para receber tráfego: banco e Redis respondendo.
  app.get("/ready", { logLevel: "warn" }, async (_request, reply) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        const started = now();
        try {
          await withTimeout(check(), checkTimeoutMs);
          return [name, { ok: true, latencyMs: now() - started }] as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return [name, { ok: false, latencyMs: now() - started, error: message }] as const;
        }
      }),
    );
    const results: Record<string, CheckResult> = Object.fromEntries(entries);
    const allOk = entries.every(([, result]) => result.ok);

    // O worker não bloqueia a API: só informa se ele parou de bater.
    let lastHeartbeatAt: string | null = null;
    try {
      lastHeartbeatAt = await withTimeout(workerHeartbeat(), checkTimeoutMs);
    } catch {
      lastHeartbeatAt = null;
    }
    const stale =
      lastHeartbeatAt === null || now() - Date.parse(lastHeartbeatAt) > WORKER_STALE_AFTER_MS;

    const body: ReadyResponse = {
      status: allOk ? "ok" : "error",
      version,
      checks: results,
      worker: { lastHeartbeatAt, stale },
    };
    return reply.code(allOk ? 200 : 503).send(body);
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;
