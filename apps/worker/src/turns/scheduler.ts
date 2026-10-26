import type { Logger } from "@rfl-bot/core";
import { BotStatus, type Db, TurnStatus } from "@rfl-bot/db";
import { ABORT_REASON } from "./execute-turn";

export type TurnSchedulerOptions = {
  db: Db;
  logger: Logger;
  /** Quantos bots trabalham ao mesmo tempo. */
  maxConcurrent: number;
  /** Executa um turno já marcado como RUNNING. */
  execute: (turnId: string, signal: AbortSignal) => Promise<unknown>;
  /** Confere a fila de tempos em tempos, caso um aviso do Redis se perca. */
  pollMs?: number;
  /** Quantas vezes um turno pode ser retomado depois de uma queda. */
  maxAttempts?: number;
  /** Só turnos deste workspace (testes que dividem o mesmo banco). Vazio = todos. */
  workspaceId?: string;
};

/**
 * Fila FIFO por bot (direção: filas do OpenBot). O Postgres é a fonte da verdade:
 * cada bot faz um turno por vez, na ordem de chegada, e bots diferentes trabalham
 * em paralelo até o limite. O Redis só acorda o agendador mais rápido.
 * Pensado para um único worker.
 */
export class TurnScheduler {
  readonly #options: Required<Omit<TurnSchedulerOptions, "workspaceId">> &
    Pick<TurnSchedulerOptions, "workspaceId">;
  readonly #runningBots = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  #timer: NodeJS.Timeout | undefined;
  #stopping = false;
  #pumping = false;
  #pumpAgain = false;

  constructor(options: TurnSchedulerOptions) {
    this.#options = { pollMs: 5000, maxAttempts: 2, ...options };
  }

  /** Filtro de workspace para as consultas de turnos. */
  get #scope() {
    return this.#options.workspaceId ? { bot: { workspaceId: this.#options.workspaceId } } : {};
  }

  async start(): Promise<void> {
    await this.#recover();
    this.#timer = setInterval(() => this.wake(), this.#options.pollMs);
    this.#timer.unref();
    this.wake();
  }

  /** Procura trabalho agora (chamado quando um turno entra na fila). */
  wake(): void {
    void this.#pump().catch((error: unknown) =>
      this.#options.logger.error({ err: error }, "erro ao procurar turnos"),
    );
  }

  /** Cancela turnos em andamento (/parar). */
  cancel(turnIds: string[]): void {
    for (const turnId of turnIds) this.#controllers.get(turnId)?.abort(ABORT_REASON.cancel);
  }

  get runningBots(): string[] {
    return [...this.#runningBots.keys()];
  }

  /** Para de pegar turnos; os que estão rodando voltam para a fila. */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    for (const controller of this.#controllers.values()) controller.abort(ABORT_REASON.shutdown);
    await Promise.allSettled(this.#runningBots.values());
  }

  /** Turnos que ficaram RUNNING depois de uma queda: voltam para a fila ou falham. */
  async #recover(): Promise<void> {
    const { db, logger, maxAttempts } = this.#options;
    const stale = await db.turn.findMany({
      where: { status: TurnStatus.RUNNING, ...this.#scope },
      select: { id: true, attempts: true },
    });
    for (const turn of stale) {
      if (turn.attempts + 1 < maxAttempts) {
        await db.turn.update({
          where: { id: turn.id },
          data: { status: TurnStatus.QUEUED, startedAt: null, attempts: { increment: 1 } },
        });
      } else {
        await db.turn.update({
          where: { id: turn.id },
          data: {
            status: TurnStatus.FAILED,
            error: "interrompido por quedas do worker",
            endedAt: new Date(),
          },
        });
      }
    }
    if (stale.length > 0) logger.warn({ count: stale.length }, "turnos interrompidos recuperados");
  }

  async #pump(): Promise<void> {
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#pumpAgain = false;
        if (this.#stopping) return;
        const free = this.#options.maxConcurrent - this.#runningBots.size;
        if (free <= 0) return;
        const waiting = await this.#options.db.turn.findMany({
          where: {
            status: TurnStatus.QUEUED,
            botId: { notIn: this.runningBots },
            bot: {
              status: { not: BotStatus.PAUSED },
              ...(this.#options.workspaceId ? { workspaceId: this.#options.workspaceId } : {}),
            },
          },
          distinct: ["botId"],
          orderBy: { queuedAt: "asc" },
          select: { botId: true },
          take: free,
        });
        for (const { botId } of waiting) this.#startBot(botId);
      } while (this.#pumpAgain);
    } finally {
      this.#pumping = false;
    }
  }

  #startBot(botId: string): void {
    if (this.#runningBots.has(botId)) return;
    const run = this.#runBot(botId)
      .catch((error: unknown) => this.#options.logger.error({ err: error, botId }, "erro no bot"))
      .finally(() => {
        this.#runningBots.delete(botId);
        if (!this.#stopping) this.wake();
      });
    this.#runningBots.set(botId, run);
  }

  async #runBot(botId: string): Promise<void> {
    const { db, logger, execute } = this.#options;
    await db.bot.updateMany({
      where: { id: botId, status: BotStatus.IDLE },
      data: { status: BotStatus.WORKING },
    });
    try {
      while (!this.#stopping) {
        const turnId = await this.#claimNext(botId);
        if (!turnId) return;
        const controller = new AbortController();
        this.#controllers.set(turnId, controller);
        try {
          await execute(turnId, controller.signal);
        } catch (error) {
          logger.error({ err: error, turnId }, "erro ao executar turno");
          await db.turn.updateMany({
            where: { id: turnId, status: TurnStatus.RUNNING },
            data: {
              status: TurnStatus.FAILED,
              error: "erro interno do worker",
              endedAt: new Date(),
            },
          });
        } finally {
          this.#controllers.delete(turnId);
        }
      }
    } finally {
      await db.bot.updateMany({
        where: { id: botId, status: BotStatus.WORKING },
        data: { status: BotStatus.IDLE },
      });
    }
  }

  /** Marca o turno mais antigo do bot como RUNNING e devolve o id. */
  async #claimNext(botId: string): Promise<string | null> {
    const { db } = this.#options;
    const bot = await db.bot.findUnique({ where: { id: botId }, select: { status: true } });
    if (!bot || bot.status === BotStatus.PAUSED) return null;
    const next = await db.turn.findFirst({
      where: { botId, status: TurnStatus.QUEUED },
      orderBy: { queuedAt: "asc" },
      select: { id: true },
    });
    if (!next) return null;
    const claimed = await db.turn.updateMany({
      where: { id: next.id, status: TurnStatus.QUEUED },
      data: { status: TurnStatus.RUNNING, startedAt: new Date() },
    });
    return claimed.count === 1 ? next.id : this.#claimNext(botId);
  }
}
