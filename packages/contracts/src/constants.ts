/** Nomes das filas do BullMQ. */
export const QUEUES = {
  /** Tarefas internas do sistema (batimento do worker, manutenção). */
  system: "system",
  /** Mensagens para enviar no WhatsApp. */
  whatsappOut: "whatsapp-out",
} as const;

/** Chaves do Redis compartilhadas entre os processos. */
export const REDIS_KEYS = {
  /** Data ISO do último batimento do worker. */
  workerHeartbeat: "rfl:worker:heartbeat",
  /** Estado da conexão do WhatsApp (JSON). */
  whatsappStatus: "rfl:whatsapp:status",
} as const;

/** Canais de pub/sub do Redis. */
export const REDIS_CHANNELS = {
  /** Um turno entrou na fila: { botId }. Acorda o worker. */
  turnQueued: "rfl:turn-queued",
  /** Cancelar turnos em andamento: { turnIds }. */
  turnCancel: "rfl:turn-cancel",
  /** Mostrar "digitando…" num chat: { chatId, typing }. */
  typing: "rfl:typing",
} as const;

/** Depois desse tempo sem batimento, o worker é considerado parado. */
export const WORKER_STALE_AFTER_MS = 3 * 60_000;
