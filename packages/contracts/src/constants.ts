/** Nomes das filas do BullMQ. */
export const QUEUES = {
  /** Tarefas internas do sistema (batimento do worker, manutenção). */
  system: "system",
} as const;

/** Chaves do Redis compartilhadas entre a API e o worker. */
export const REDIS_KEYS = {
  /** Data ISO do último batimento do worker. */
  workerHeartbeat: "rfl:worker:heartbeat",
} as const;

/** Depois desse tempo sem batimento, o worker é considerado parado. */
export const WORKER_STALE_AFTER_MS = 3 * 60_000;
