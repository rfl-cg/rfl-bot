import type { MessageContent } from "@rfl-bot/contracts";
import { Channel, type Db, TurnStatus } from "@rfl-bot/db";

/**
 * Guarda a mensagem e coloca na fila do bot. Se a conversa já tem um turno
 * esperando, a mensagem entra nele: várias mensagens seguidas = uma resposta.
 */
export async function enqueueUserMessage(
  db: Db,
  { botId, chatId, content }: { botId: string; chatId: string; content: MessageContent },
): Promise<{ turnId: string; newTurn: boolean }> {
  return db.$transaction(async (tx) => {
    const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId } });
    const now = new Date();
    const conversation = await tx.conversation.upsert({
      where: {
        botId_channel_externalChatId: { botId, channel: Channel.WHATSAPP, externalChatId: chatId },
      },
      create: { botId, channel: Channel.WHATSAPP, externalChatId: chatId, lastMessageAt: now },
      update: { lastMessageAt: now },
    });
    const waiting = await tx.turn.findFirst({
      where: { conversationId: conversation.id, status: TurnStatus.QUEUED },
      orderBy: { queuedAt: "desc" },
      select: { id: true },
    });
    const turn =
      waiting ??
      (await tx.turn.create({
        data: { botId, conversationId: conversation.id, provider: bot.provider, model: bot.model },
        select: { id: true },
      }));
    await tx.message.create({
      data: { conversationId: conversation.id, role: "USER", content, turnId: turn.id },
    });
    return { turnId: turn.id, newTurn: !waiting };
  });
}
