import type { Logger } from "./logger";

export type Closer = {
  name: string;
  close: () => Promise<unknown>;
};

export type ShutdownOptions = {
  logger: Logger;
  /** Fechados na ordem da lista. Coloque primeiro o que recebe trabalho novo (servidor HTTP, worker). */
  closers: Closer[];
  timeoutMs?: number;
  exit?: (code: number) => void;
};

export type Shutdown = (reason: string, exitCode?: number) => Promise<void>;

/**
 * Desliga o processo com calma: para de aceitar trabalho, fecha conexões e sai.
 * Se algo travar, sai à força depois de `timeoutMs`.
 */
export function createShutdown({
  logger,
  closers,
  timeoutMs = 10_000,
  exit = (code) => process.exit(code),
}: ShutdownOptions): Shutdown {
  let running: Promise<void> | undefined;

  return (reason, exitCode = 0) => {
    if (running) return running;

    running = (async () => {
      logger.info({ reason }, "desligando");
      const timer = setTimeout(() => {
        logger.error({ timeoutMs }, "desligamento demorou demais; saindo à força");
        exit(1);
      }, timeoutMs);
      timer.unref();

      let code = exitCode;
      for (const closer of closers) {
        try {
          await closer.close();
          logger.debug({ closer: closer.name }, "fechado");
        } catch (error) {
          code = 1;
          logger.error({ err: error, closer: closer.name }, "erro ao fechar");
        }
      }

      clearTimeout(timer);
      logger.info({ exitCode: code }, "desligado");
      exit(code);
    })();

    return running;
  };
}

/** Liga o desligamento aos sinais do sistema (Docker manda SIGTERM) e a erros fatais. */
export function installShutdownHandlers(shutdown: Shutdown, logger: Logger): void {
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "erro não tratado");
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (error) => {
    logger.fatal({ err: error }, "promessa rejeitada sem tratamento");
    void shutdown("unhandledRejection", 1);
  });
}
