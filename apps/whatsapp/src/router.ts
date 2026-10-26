import { REDIS_CHANNELS } from "@rfl-bot/contracts";
import type { Logger } from "@rfl-bot/core";
import type { Db } from "@rfl-bot/db";
import type { Redis } from "ioredis";
import { type AccessRules, accessFor, parseCommand, parseMention } from "./access";
import { defaultBotId } from "./bootstrap";
import type { IncomingMessage } from "./incoming";
import { enqueueUserMessage } from "./queueing";

export type InboundDeps = {
  db: Db;
  redis: Pick<Redis, "set" | "publish">;
  logger: Logger;
  rules: AccessRules;
  workspaceId: string;
  botPhone: string;
  reply: (chatId: string, text: string) => Promise<void>;
  markRead: (incoming: IncomingMessage) => Promise<void>;
  /** Comandos do dono (/bots, /login…). */
  runCommand: (
    incoming: IncomingMessage,
    command: { name: string; args: string },
  ) => Promise<string>;
  /** Mensagens mais velhas que isso (ex.: depois de muito tempo desconectado) são ignoradas. */
  maxAgeSeconds?: number;
  now?: () => number;
};

export type InboundResult =
  | "duplicate"
  | "old"
  | "denied"
  | "command"
  | "media"
  | "unknown-bot"
  | "queued";

/** Decide o que fazer com cada mensagem recebida. */
export async function handleIncoming(
  deps: InboundDeps,
  incoming: IncomingMessage,
): Promise<InboundResult> {
  const { db, redis, logger, rules } = deps;
  const now = deps.now?.() ?? Date.now();

  // O WhatsApp pode entregar a mesma mensagem de novo depois de reconectar.
  const fresh = await redis.set(`rfl:wa-seen:${incoming.id}`, "1", "EX", 86_400, "NX");
  if (fresh !== "OK") return "duplicate";
  if (
    incoming.timestamp > 0 &&
    now / 1000 - incoming.timestamp > (deps.maxAgeSeconds ?? 6 * 3600)
  ) {
    return "old";
  }

  const access = accessFor(incoming.senderPhone, rules);
  if (access === "denied") {
    logger.info(
      { phone: maskPhone(incoming.senderPhone) },
      "mensagem de número não liberado ignorada",
    );
    return "denied";
  }
  await deps.markRead(incoming).catch(() => {});

  const command = access === "owner" ? parseCommand(incoming.text) : null;
  if (command) {
    const answer = await deps.runCommand(incoming, command);
    await deps.reply(incoming.chatId, answer);
    // O texto de comandos (ex.: /codigo) nunca vai para o banco nem para o log.
    logger.info({ command: command.name }, "comando do dono");
    return "command";
  }

  if (incoming.kind === "media") {
    await deps.reply(
      incoming.chatId,
      "Por enquanto eu só leio mensagens de texto. Áudios, fotos e arquivos chegam numa próxima versão. 🙂",
    );
    return "media";
  }

  let botId: string | null;
  let text = incoming.text;
  const mention = parseMention(incoming.text);
  if (mention) {
    const bot = await db.bot.findFirst({
      where: { workspaceId: deps.workspaceId, name: { equals: mention.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (!bot) {
      await deps.reply(incoming.chatId, `Não conheço o bot @${mention.name}.`);
      return "unknown-bot";
    }
    botId = bot.id;
    text = mention.text || "Oi!";
  } else {
    botId = await defaultBotId(db, deps.botPhone);
  }
  if (!botId) {
    await deps.reply(incoming.chatId, "Nenhum bot está atendendo este número ainda.");
    return "unknown-bot";
  }

  await enqueueUserMessage(db, {
    botId,
    chatId: incoming.chatId,
    content: {
      text,
      ...(incoming.senderName ? { senderName: incoming.senderName } : {}),
      ...(incoming.senderPhone ? { senderPhone: incoming.senderPhone } : {}),
      fromOwner: access === "owner",
      externalId: incoming.id,
    },
  });
  await redis.publish(REDIS_CHANNELS.turnQueued, JSON.stringify({ botId }));
  return "queued";
}

/** 5511999998888 → 55119****8888 (para log). */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length > 8 ? `${phone.slice(0, 5)}****${phone.slice(-4)}` : "****";
}
