import { QUEUES, REDIS_KEYS } from "@rfl-bot/contracts";
import type { Logger } from "@rfl-bot/core";
import { type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

export type SystemQueueOptions = {
  redis: Redis;
  logger: Logger;
  heartbeatEveryMs: number;
  /** Prefixo das chaves do BullMQ no Redis. Os testes usam um prefixo próprio. */
  prefix?: string;
  heartbeatKey?: string;
};

export type SystemQueue = {
  close: () => Promise<void>;
};

/**
 * Fila de tarefas internas. Por enquanto só tem o "batimento": a cada N segundos
 * o worker grava a hora no Redis, e a API mostra em /ready se ele parou.
 * As rotinas dos bots (Fase 2) usam o mesmo agendador do BullMQ.
 */
export async function startSystemQueue({
  redis,
  logger,
  heartbeatEveryMs,
  prefix = "bull",
  heartbeatKey = REDIS_KEYS.workerHeartbeat,
}: SystemQueueOptions): Promise<SystemQueue> {
  const beat = () => redis.set(heartbeatKey, new Date().toISOString(), "EX", 600);

  const queue = new Queue(QUEUES.system, { connection: redis, prefix });
  await queue.upsertJobScheduler(
    "heartbeat",
    { every: heartbeatEveryMs },
    { name: "heartbeat", opts: { removeOnComplete: true, removeOnFail: 100 } },
  );

  const worker = new Worker(
    QUEUES.system,
    async (job: Job) => {
      switch (job.name) {
        case "heartbeat":
          await beat();
          return;
        default:
          throw new Error(`tarefa desconhecida: ${job.name}`);
      }
    },
    { connection: redis, prefix, concurrency: 1 },
  );
  worker.on("failed", (job, error) =>
    logger.error({ err: error, job: job?.name, jobId: job?.id }, "tarefa falhou"),
  );
  worker.on("error", (error) => logger.error({ err: error }, "erro no worker"));

  await worker.waitUntilReady();
  await beat();
  logger.info({ queue: QUEUES.system, heartbeatEveryMs }, "fila do sistema ligada");

  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
