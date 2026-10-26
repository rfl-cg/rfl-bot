import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";
import { createShutdown } from "./shutdown";

const logger = createLogger({ name: "test", level: "silent" });

describe("createShutdown", () => {
  it("fecha tudo na ordem e sai com código 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger,
      exit,
      closers: [
        { name: "http", close: async () => order.push("http") },
        { name: "db", close: async () => order.push("db") },
      ],
    });

    await shutdown("teste");

    expect(order).toEqual(["http", "db"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("continua fechando quando um item falha e sai com código 1", async () => {
    const exit = vi.fn();
    const closeDb = vi.fn(async () => {});
    const shutdown = createShutdown({
      logger,
      exit,
      closers: [
        {
          name: "http",
          close: async () => {
            throw new Error("falhou");
          },
        },
        { name: "db", close: closeDb },
      ],
    });

    await shutdown("teste");

    expect(closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("roda uma vez só, mesmo chamado várias vezes", async () => {
    const exit = vi.fn();
    const close = vi.fn(async () => {});
    const shutdown = createShutdown({ logger, exit, closers: [{ name: "db", close }] });

    await Promise.all([shutdown("a"), shutdown("b")]);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("sai à força quando algo trava", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdown({
        logger,
        exit,
        timeoutMs: 1000,
        closers: [{ name: "travado", close: () => new Promise(() => {}) }],
      });

      void shutdown("teste");
      await vi.advanceTimersByTimeAsync(1000);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
