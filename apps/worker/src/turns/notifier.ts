import { REDIS_CHANNELS, type WhatsappOutJob } from "@rfl-bot/contracts";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { TurnNotifier } from "./execute-turn";

const JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

/** Respostas vão pela fila whatsapp-out; "digitando…" vai por pub/sub. */
export function createTurnNotifier({
  queue,
  publisher,
}: {
  queue: Queue<WhatsappOutJob>;
  publisher: Redis;
}): TurnNotifier {
  return {
    async typing(chatId, typing) {
      await publisher.publish(REDIS_CHANNELS.typing, JSON.stringify({ chatId, typing }));
    },
    async reply(chatId, text, turnId) {
      // jobId fixo: se o worker repetir, a mesma resposta não sai duas vezes.
      await queue.add(
        "reply",
        { to: { kind: "chat", chatId }, text },
        { ...JOB_OPTIONS, jobId: `reply-${turnId}` },
      );
    },
    async owner(text, key) {
      await queue.add(
        "owner",
        { to: { kind: "owner" }, text },
        { ...JOB_OPTIONS, jobId: `owner-${key}` },
      );
    },
  };
}
