import {
  QUEUES,
  REDIS_CHANNELS,
  turnCancelEventSchema,
  type WhatsappOutJob,
  workerEnvSchema,
} from "@rfl-bot/contracts";
import { createLogger, createShutdown, installShutdownHandlers, loadEnv } from "@rfl-bot/core";
import { createDb, pingDb } from "@rfl-bot/db";
import { createRunnerClient } from "@rfl-bot/runner-client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { startSystemQueue } from "./system-queue";
import { executeTurn } from "./turns/execute-turn";
import { createTurnNotifier } from "./turns/notifier";
import { TurnScheduler } from "./turns/scheduler";

const env = loadEnv(workerEnvSchema);
const logger = createLogger({ name: "worker", level: env.LOG_LEVEL });

// O BullMQ exige maxRetriesPerRequest: null nas conexões do worker.
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (error) => logger.warn({ err: error }, "redis indisponível"));
// Conexão só para ouvir os avisos (uma conexão em modo subscribe não manda outros comandos).
const subscriber = redis.duplicate();
subscriber.on("error", (error) => logger.warn({ err: error }, "redis (avisos) indisponível"));

const db = createDb(env.DATABASE_URL);
await pingDb(db);

const outQueue = new Queue<WhatsappOutJob>(QUEUES.whatsappOut, { connection: redis });
const runner = createRunnerClient({ url: env.RUNNER_URL, token: env.RUNNER_TOKEN });
const notifier = createTurnNotifier({ queue: outQueue, publisher: redis });

const scheduler = new TurnScheduler({
  db,
  logger,
  maxConcurrent: env.MAX_CONCURRENT_TURNS,
  execute: (turnId, signal) =>
    executeTurn(
      { db, runner, notifier, logger, turnTimeoutMs: env.TURN_TIMEOUT_MS },
      turnId,
      signal,
    ),
});

subscriber.on("message", (channel, raw) => {
  if (channel === REDIS_CHANNELS.turnQueued) {
    scheduler.wake();
    return;
  }
  if (channel === REDIS_CHANNELS.turnCancel) {
    try {
      scheduler.cancel(turnCancelEventSchema.parse(JSON.parse(raw)).turnIds);
    } catch (error) {
      logger.warn({ err: error }, "aviso de cancelamento inválido");
    }
  }
});
await subscriber.subscribe(REDIS_CHANNELS.turnQueued, REDIS_CHANNELS.turnCancel);

const systemQueue = await startSystemQueue({
  redis,
  logger,
  heartbeatEveryMs: env.WORKER_HEARTBEAT_MS,
});
await scheduler.start();

const shutdown = createShutdown({
  logger,
  timeoutMs: 20_000,
  closers: [
    // Primeiro para de pegar turnos; os que estão rodando voltam para a fila.
    { name: "turnos", close: () => scheduler.stop() },
    { name: "system-queue", close: () => systemQueue.close() },
    { name: "avisos", close: () => subscriber.quit() },
    { name: "fila whatsapp-out", close: () => outQueue.close() },
    { name: "redis", close: () => redis.quit() },
    { name: "database", close: () => db.$disconnect() },
  ],
});
installShutdownHandlers(shutdown, logger);

logger.info(
  { version: env.APP_VERSION, maxConcurrentTurns: env.MAX_CONCURRENT_TURNS },
  "worker no ar",
);
