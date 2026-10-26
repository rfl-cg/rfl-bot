import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "@rfl-bot/core";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startSystemQueue } from "./system-queue";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (!process.env.REDIS_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const redisUrl = process.env.REDIS_URL;

// Precisa de um Redis rodando (pnpm services:up).
describe.skipIf(!redisUrl)("fila do sistema", () => {
  const id = `rfl-test-${Date.now()}`;
  const redis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
  const logger = createLogger({ name: "test", level: "silent" });

  afterAll(async () => {
    const keys = await redis.keys(`${id}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("grava o batimento ao ligar e de novo pelo agendador", async () => {
    const heartbeatKey = `${id}:heartbeat`;
    const queue = await startSystemQueue({
      redis,
      logger,
      heartbeatEveryMs: 200,
      prefix: id,
      heartbeatKey,
    });

    try {
      expect(await redis.get(heartbeatKey)).not.toBeNull();

      // Apaga e espera o agendador gravar de novo.
      await redis.del(heartbeatKey);
      await vi.waitFor(
        async () => {
          expect(await redis.get(heartbeatKey)).not.toBeNull();
        },
        { timeout: 5000, interval: 50 },
      );
      expect(await redis.ttl(heartbeatKey)).toBeGreaterThan(500);
    } finally {
      await queue.close();
    }
  });
});
