import { apiEnvSchema, REDIS_KEYS } from "@rfl-bot/contracts";
import { createLogger, createShutdown, installShutdownHandlers, loadEnv } from "@rfl-bot/core";
import { createDb, pingDb } from "@rfl-bot/db";
import { Redis } from "ioredis";
import { buildApp } from "./app";

const env = loadEnv(apiEnvSchema);
const logger = createLogger({ name: "api", level: env.LOG_LEVEL });

const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on("error", (error) => logger.warn({ err: error }, "redis indisponível"));

const app = buildApp({
  logger,
  version: env.APP_VERSION,
  checks: {
    database: () => pingDb(db),
    redis: () => redis.ping(),
  },
  workerHeartbeat: () => redis.get(REDIS_KEYS.workerHeartbeat),
});

const shutdown = createShutdown({
  logger,
  closers: [
    { name: "http", close: () => app.close() },
    { name: "redis", close: () => redis.quit() },
    { name: "database", close: () => db.$disconnect() },
  ],
});
installShutdownHandlers(shutdown, logger);

await app.listen({ host: env.API_HOST, port: env.API_PORT });
logger.info({ version: env.APP_VERSION }, "api no ar");
