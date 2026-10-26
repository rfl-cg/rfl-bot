import { QUEUES, type WhatsappOutJob, whatsappOutJobSchema } from "@rfl-bot/contracts";
import type { Logger } from "@rfl-bot/core";
import { type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { splitMessage, toWhatsAppText } from "./format";
import type { WhatsAppTransport } from "./transport";

export type OutboundOptions = {
  redis: Redis;
  transport: WhatsAppTransport;
  /** Chat do dono (telefone@s.whatsapp.net). */
  ownerChatId: string;
  logger: Logger;
  maxPerMinute: number;
  /** Para de mostrar "digitando…" quando a resposta sai. */
  onSent?: (chatId: string) => void;
  prefix?: string;
};

/** Envia as mensagens da fila whatsapp-out, com limite por minuto (reduz o risco de bloqueio). */
export function startOutbound({
  redis,
  transport,
  ownerChatId,
  logger,
  maxPerMinute,
  onSent,
  prefix = "bull",
}: OutboundOptions): Worker<WhatsappOutJob> {
  const worker = new Worker<WhatsappOutJob>(
    QUEUES.whatsappOut,
    async (job: Job<WhatsappOutJob>) => {
      const data = whatsappOutJobSchema.parse(job.data);
      const chatId = data.to.kind === "owner" ? ownerChatId : data.to.chatId;
      if (!transport.connected) throw new Error("WhatsApp desconectado; tento de novo depois");

      const parts = splitMessage(toWhatsAppText(data.text));
      // Se uma tentativa anterior mandou parte do texto, continua de onde parou.
      const alreadySent = typeof job.progress === "number" ? job.progress : 0;
      for (let index = alreadySent; index < parts.length; index += 1) {
        await transport.sendText(chatId, parts[index] as string);
        await job.updateProgress(index + 1);
      }
      onSent?.(chatId);
    },
    { connection: redis, prefix, concurrency: 1, limiter: { max: maxPerMinute, duration: 60_000 } },
  );
  worker.on("failed", (job, error) =>
    logger.warn({ err: error, jobId: job?.id, attempts: job?.attemptsMade }, "envio falhou"),
  );
  worker.on("error", (error) => logger.error({ err: error }, "erro na fila de envio"));
  return worker;
}
