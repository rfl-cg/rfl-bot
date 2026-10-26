import { randomUUID } from "node:crypto";
import {
  type FailureCode,
  messageContentSchema,
  type ProviderId,
  providerIdSchema,
  type RuntimeEvent,
  type TurnRequest,
} from "@rfl-bot/contracts";
import type { Logger } from "@rfl-bot/core";
import { type Db, type Prisma, TurnStatus } from "@rfl-bot/db";
import { type RunnerClient, RunnerError } from "@rfl-bot/runner-client";
import { buildTurnInput } from "./input";
import { buildInstructions } from "./instructions";

/** Por que um turno foi abortado de fora. */
export const ABORT_REASON = {
  /** O worker está desligando: o turno volta para a fila. */
  shutdown: "shutdown",
  /** O dono mandou /parar. */
  cancel: "cancel",
} as const;

export type TurnNotifier = {
  /** Mostra ou esconde "digitando…" no chat. */
  typing(chatId: string, typing: boolean): Promise<void>;
  /** Manda a resposta do turno para o chat. */
  reply(chatId: string, text: string, turnId: string): Promise<void>;
  /** Avisa o dono (ex.: o bot não conseguiu responder outra pessoa). */
  owner(text: string, key: string): Promise<void>;
};

export type ExecuteTurnDeps = {
  db: Db;
  runner: Pick<RunnerClient, "streamTurn">;
  notifier: TurnNotifier;
  logger: Logger;
  turnTimeoutMs: number;
};

export type TurnOutcome = "done" | "failed" | "canceled" | "requeued";

const GENERIC_FAILURE = "Desculpe, não consegui responder agora. Tente de novo daqui a pouco.";
const MAX_EVENT_INPUT_CHARS = 2000;

/** Executa um turno que já está RUNNING e grava o resultado. */
export async function executeTurn(
  deps: ExecuteTurnDeps,
  turnId: string,
  signal: AbortSignal,
): Promise<TurnOutcome> {
  const { db, runner, notifier, logger } = deps;
  const log = logger.child({ turnId });

  const turn = await db.turn.findUniqueOrThrow({
    where: { id: turnId },
    include: {
      bot: true,
      conversation: true,
      messages: { where: { role: "USER" }, orderBy: { createdAt: "asc" } },
    },
  });
  const { bot, conversation } = turn;
  const chatId = conversation.channel === "WHATSAPP" ? conversation.externalChatId : null;
  const contents = turn.messages.map((message) => messageContentSchema.safeParse(message.content));
  const fromOwner = contents.some((result) => result.success && result.data.fromOwner === true);
  const senderName = contents.find((result) => result.success && result.data.senderName)?.data
    ?.senderName;

  const input = buildTurnInput(turn.messages.map((message) => message.content));
  const provider = providerIdSchema.safeParse(turn.provider);
  if (!input || !provider.success) {
    await finish(db, turnId, TurnStatus.FAILED, {
      error: input ? `provedor desconhecido: ${turn.provider}` : "turno sem mensagem",
    });
    return "failed";
  }

  const saved = await db.providerSession.findUnique({
    where: {
      botId_conversationId_provider: {
        botId: bot.id,
        conversationId: conversation.id,
        provider: provider.data,
      },
    },
  });
  const session = saved
    ? { id: saved.nativeSessionId, resume: true }
    : { id: randomUUID(), resume: false };

  const request: TurnRequest = {
    turnId,
    botId: bot.id,
    provider: provider.data,
    model: turn.model,
    ...(isEffort(bot.effort) ? { effort: bot.effort } : {}),
    instructions: buildInstructions(bot, conversation.channel),
    session,
    input,
  };

  const timeout = AbortSignal.timeout(deps.turnTimeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let seq = 0;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let final: Extract<RuntimeEvent, { type: "turn.completed" | "turn.failed" }> | undefined;

  if (chatId) await notifier.typing(chatId, true).catch(() => {});
  try {
    for await (const event of runner.streamTurn(request, combined)) {
      if (event.type === "text.delta") continue;
      await db.event.create({
        data: { turnId, seq: seq++, type: event.type, payload: eventPayload(event) },
      });
      if (event.type === "usage") usage = event;
      if (event.type === "turn.completed" || event.type === "turn.failed") final = event;
    }
  } catch (error) {
    if (!combined.aborted) {
      final =
        error instanceof RunnerError
          ? { type: "turn.failed", error: error.message, code: error.code }
          : { type: "turn.failed", error: errorMessage(error), code: "internal" };
    }
  } finally {
    if (chatId) await notifier.typing(chatId, false).catch(() => {});
  }

  // Abortado de fora: desligamento, /parar ou tempo esgotado (a não ser que já tenha terminado).
  const abortedFromOutside =
    final?.type !== "turn.completed" && (combined.aborted || final?.code === "interrupted");
  if (abortedFromOutside) {
    if (signal.aborted && signal.reason === ABORT_REASON.shutdown) {
      await requeue(db, turnId);
      log.info("turno volta para a fila (desligamento)");
      return "requeued";
    }
    if (signal.aborted) {
      await finish(db, turnId, TurnStatus.CANCELED, { error: "cancelado pelo dono", usage });
      log.info("turno cancelado");
      return "canceled";
    }
    if (timeout.aborted) {
      await finish(db, turnId, TurnStatus.FAILED, { error: "tempo esgotado", usage });
      if (chatId) {
        await notifier.reply(
          chatId,
          "⏱️ Esse pedido demorou demais e eu parei. Tente dividir em partes menores.",
          turnId,
        );
      }
      return "failed";
    }
  }

  if (final?.type === "turn.completed") {
    const text = final.finalText.trim() || "✅ Feito.";
    await db.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "BOT",
          content: { text },
          authorBotId: bot.id,
          turnId,
        },
      });
      await tx.turn.update({
        where: { id: turnId },
        data: {
          status: TurnStatus.DONE,
          endedAt: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      if (!session.resume) {
        await tx.providerSession.upsert({
          where: {
            botId_conversationId_provider: {
              botId: bot.id,
              conversationId: conversation.id,
              provider: provider.data,
            },
          },
          create: {
            botId: bot.id,
            conversationId: conversation.id,
            provider: provider.data,
            nativeSessionId: session.id,
          },
          update: { nativeSessionId: session.id },
        });
      }
    });
    if (chatId) await notifier.reply(chatId, text, turnId);
    log.info(
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      "turno concluído",
    );
    return "done";
  }

  const failure = final ?? {
    type: "turn.failed" as const,
    error: "o runner terminou sem resposta",
    code: "internal" as const,
  };

  // Runner ocupado: espera a vez de novo.
  if (failure.code === "runner_busy") {
    await requeue(db, turnId);
    return "requeued";
  }

  await finish(db, turnId, TurnStatus.FAILED, { error: failure.error, usage });
  log.warn({ code: failure.code }, "turno falhou");
  if (chatId) {
    await notifier.reply(
      chatId,
      fromOwner ? ownerFailureText(failure.code, failure.error, provider.data) : GENERIC_FAILURE,
      turnId,
    );
  }
  if (!fromOwner) {
    await notifier.owner(
      `⚠️ *${bot.name}* não conseguiu responder ${senderName ?? "um contato"}: ${failure.error}`,
      turnId,
    );
  }
  return "failed";
}

function ownerFailureText(code: FailureCode, error: string, provider: ProviderId): string {
  if (code === "not_signed_in") {
    return `⚠️ O *${provider}* não está conectado. Mande */login ${provider}* para conectar a sua assinatura.`;
  }
  return `⚠️ Não consegui responder: ${error}`;
}

async function finish(
  db: Db,
  turnId: string,
  status: TurnStatus,
  { error, usage }: { error: string; usage?: { inputTokens: number; outputTokens: number } },
): Promise<void> {
  await db.turn.update({
    where: { id: turnId },
    data: {
      status,
      error,
      endedAt: new Date(),
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    },
  });
}

async function requeue(db: Db, turnId: string): Promise<void> {
  await db.turn.update({
    where: { id: turnId },
    data: { status: TurnStatus.QUEUED, startedAt: null },
  });
}

/** Evento como JSON do banco. A entrada de ferramentas grande demais não é guardada. */
function eventPayload(event: RuntimeEvent): Prisma.InputJsonValue {
  if (event.type === "tool.started" && event.input !== undefined) {
    const serialized = JSON.stringify(event.input) ?? "";
    if (serialized.length > MAX_EVENT_INPUT_CHARS) {
      return { type: event.type, name: event.name, inputOmitted: true };
    }
  }
  return JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
}

function isEffort(value: string | null): value is NonNullable<TurnRequest["effort"]> {
  return value !== null && ["low", "medium", "high", "xhigh", "max"].includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
