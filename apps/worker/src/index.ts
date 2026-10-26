import { workerEnvSchema } from "@rfl-bot/contracts";
import { createLogger, createShutdown, installShutdownHandlers, loadEnv } from "@rfl-bot/core";
import { createDb, pingDb } from "@rfl-bot/db";
import { Redis } from "ioredis";
import { startSystemQueue } from "./system-queue";

const env = loadEnv(workerEnvSchema);
const logger = createLogger({ name: "worker", level: env.LOG_LEVEL });

// O BullMQ exige maxRetriesPerRequest: null nas conexões do worker.
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (error) => logger.warn({ err: error }, "redis indisponível"));

const db = createDb(env.DATABASE_URL);
await pingDb(db);

const systemQueue = await startSystemQueue({
  redis,
  logger,
  heartbeatEveryMs: env.WORKER_HEARTBEAT_MS,
});

const shutdown = createShutdown({
  logger,
  closers: [
    { name: "system-queue", close: () => systemQueue.close() },
    { name: "redis", close: () => redis.quit() },
    { name: "database", close: () => db.$disconnect() },
  ],
});
installShutdownHandlers(shutdown, logger);

logger.info({ version: env.APP_VERSION }, "worker no ar");
