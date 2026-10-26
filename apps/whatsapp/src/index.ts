import { mkdir } from "node:fs/promises";
import {
  QUEUES,
  REDIS_CHANNELS,
  REDIS_KEYS,
  typingEventSchema,
  type WhatsappOutJob,
  whatsappEnvSchema,
} from "@rfl-bot/contracts";
import { createLogger, createShutdown, installShutdownHandlers, loadEnv } from "@rfl-bot/core";
import { createDb, pingDb } from "@rfl-bot/db";
import { createRunnerClient } from "@rfl-bot/runner-client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { ensureDefaults } from "./bootstrap";
import { type CommandContext, runCommand } from "./commands";
import { type ConnectionStatus, offlineConnection, startWhatsAppConnection } from "./connection";
import { parseIncoming } from "./incoming";
import { startOutbound } from "./outbound";
import { handleIncoming, maskPhone } from "./router";
import { TypingManager } from "./typing";

const env = loadEnv(whatsappEnvSchema);
const logger = createLogger({ name: "whatsapp", level: env.LOG_LEVEL });

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (error) => logger.warn({ err: error }, "redis indisponível"));
const subscriber = redis.duplicate();
subscriber.on("error", (error) => logger.warn({ err: error }, "redis (avisos) indisponível"));

const db = createDb(env.DATABASE_URL);
await pingDb(db);
await mkdir(env.WHATSAPP_AUTH_DIR, { recursive: true });

const workspaceId = await ensureDefaults(db, { botPhone: env.WHATSAPP_PHONE });
const runner = createRunnerClient({ url: env.RUNNER_URL, token: env.RUNNER_TOKEN });
const ownerChatId = `${env.WHATSAPP_OWNER}@s.whatsapp.net`;

const outQueue = new Queue<WhatsappOutJob>(QUEUES.whatsappOut, { connection: redis });
const reply = async (chatId: string, text: string) => {
  await outQueue.add(
    "reply",
    { to: { kind: "chat", chatId }, text },
    {
      attempts: 8,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
};

const reportStatus = (status: ConnectionStatus) => {
  void redis
    .set(
      REDIS_KEYS.whatsappStatus,
      JSON.stringify({ ...status, at: new Date().toISOString() }),
      "EX",
      3600,
    )
    .catch(() => {});
  if (status.state === "pairing") {
    logger.warn(
      { pairingCode: status.pairingCode, phone: maskPhone(env.WHATSAPP_PHONE) },
      "PAREAR O WHATSAPP: no celular do bot, abra Dispositivos conectados → Conectar dispositivo → " +
        "Conectar com número de telefone, e digite o código",
    );
  } else if (status.state === "open") {
    logger.info("WhatsApp conectado");
  } else if (status.state === "logged_out") {
    logger.warn("o aparelho foi desconectado no celular; vou mostrar um código novo");
  } else if (status.state === "closed") {
    logger.info({ reason: status.reason }, "conexão do WhatsApp caiu; reconectando");
  }
};

const logins: CommandContext["logins"] = { pending: null };
let inbound = Promise.resolve();

const connection = env.WHATSAPP_CONNECT
  ? startWhatsAppConnection({
      authDir: env.WHATSAPP_AUTH_DIR,
      phone: env.WHATSAPP_PHONE,
      logger,
      onStatus: reportStatus,
      onMessages: (messages) => {
        // Uma mensagem por vez, na ordem em que chegaram.
        for (const message of messages) {
          const incoming = parseIncoming(message);
          if (!incoming) continue;
          inbound = inbound
            .then(() =>
              handleIncoming(
                {
                  db,
                  redis,
                  logger,
                  rules: { owner: env.WHATSAPP_OWNER, allowed: env.WHATSAPP_ALLOWED },
                  workspaceId,
                  botPhone: env.WHATSAPP_PHONE,
                  reply,
                  markRead: (item) => connection.transport.markRead(item),
                  runCommand: (item, command) =>
                    runCommand(
                      {
                        db,
                        runner,
                        workspaceId,
                        botPhone: env.WHATSAPP_PHONE,
                        chatId: item.chatId,
                        logins,
                        whatsappConnected: () => connection.transport.connected,
                        publishCancel: async (turnIds) => {
                          await redis.publish(
                            REDIS_CHANNELS.turnCancel,
                            JSON.stringify({ turnIds }),
                          );
                        },
                        wake: async (botId) => {
                          await redis.publish(REDIS_CHANNELS.turnQueued, JSON.stringify({ botId }));
                        },
                      },
                      command,
                    ),
                },
                incoming,
              ),
            )
            .then(() => {})
            .catch((error: unknown) => logger.error({ err: error }, "erro ao tratar mensagem"));
        }
      },
    })
  : offlineConnection();

const typing = new TypingManager(connection.transport, logger);
subscriber.on("message", (channel, raw) => {
  if (channel !== REDIS_CHANNELS.typing) return;
  try {
    const event = typingEventSchema.parse(JSON.parse(raw));
    typing.set(event.chatId, event.typing);
  } catch {
    logger.debug("aviso de digitando inválido");
  }
});
await subscriber.subscribe(REDIS_CHANNELS.typing);

const outbound = startOutbound({
  redis,
  transport: connection.transport,
  ownerChatId,
  logger,
  maxPerMinute: env.WHATSAPP_MAX_PER_MINUTE,
  onSent: (chatId) => typing.stop(chatId),
});

const shutdown = createShutdown({
  logger,
  closers: [
    { name: "envio", close: () => outbound.close() },
    { name: "digitando", close: async () => typing.stopAll() },
    { name: "mensagens recebidas", close: () => inbound },
    { name: "whatsapp", close: () => connection.close() },
    { name: "avisos", close: () => subscriber.quit() },
    { name: "fila whatsapp-out", close: () => outQueue.close() },
    { name: "redis", close: () => redis.quit() },
    { name: "database", close: () => db.$disconnect() },
  ],
});
installShutdownHandlers(shutdown, logger);

logger.info(
  {
    version: env.APP_VERSION,
    botPhone: maskPhone(env.WHATSAPP_PHONE),
    allowed: env.WHATSAPP_ALLOWED.length,
    connect: env.WHATSAPP_CONNECT,
  },
  env.WHATSAPP_CONNECT
    ? "gateway do WhatsApp no ar"
    : "gateway no ar SEM conectar no WhatsApp (WHATSAPP_CONNECT=false)",
);
