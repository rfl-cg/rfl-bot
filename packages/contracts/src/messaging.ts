import { z } from "zod";

/** Conteúdo de uma linha da tabela Message (campo Json). */
export const messageContentSchema = z.object({
  text: z.string(),
  /** Nome que a pessoa usa no WhatsApp. */
  senderName: z.string().optional(),
  /** Telefone de quem mandou (só dígitos). */
  senderPhone: z.string().optional(),
  /** A mensagem veio do dono. */
  fromOwner: z.boolean().optional(),
  /** Id da mensagem no WhatsApp. */
  externalId: z.string().optional(),
});
export type MessageContent = z.infer<typeof messageContentSchema>;

/** Job da fila whatsapp-out: o gateway envia o texto. */
export const whatsappOutJobSchema = z.object({
  to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("chat"), chatId: z.string().min(1) }),
    /** O gateway troca pelo número do dono. */
    z.object({ kind: z.literal("owner") }),
  ]),
  text: z.string().min(1).max(60_000),
});
export type WhatsappOutJob = z.infer<typeof whatsappOutJobSchema>;

/** Pub/sub: um turno entrou na fila. */
export const turnQueuedEventSchema = z.object({ botId: z.string().min(1) });

/** Pub/sub: cancelar turnos em andamento. */
export const turnCancelEventSchema = z.object({ turnIds: z.array(z.string().min(1)).min(1) });

/** Pub/sub: mostrar ou esconder "digitando…". */
export const typingEventSchema = z.object({ chatId: z.string().min(1), typing: z.boolean() });
