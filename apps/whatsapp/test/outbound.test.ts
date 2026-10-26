import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { QUEUES, type WhatsappOutJob } from "@rfl-bot/contracts";
import { createLogger } from "@rfl-bot/core";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../src/incoming";
import { startOutbound } from "../src/outbound";
import type { WhatsAppTransport } from "../src/transport";
import { TypingManager } from "../src/typing";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (!process.env.REDIS_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const redisUrl = process.env.REDIS_URL;
const logger = createLogger({ name: "test", level: "silent" });

function fakeTransport(connected = true) {
  const sent: Array<[string, string]> = [];
  const typing: Array<[string, boolean]> = [];
  const transport: WhatsAppTransport & { connected: boolean } = {
    connected,
    async sendText(chatId, text) {
      sent.push([chatId, text]);
    },
    async setTyping(chatId, value) {
      typing.push([chatId, value]);
    },
    async markRead(_incoming: IncomingMessage) {},
  };
  return { transport, sent, typing };
}

describe.skipIf(!redisUrl)("envio pelo WhatsApp", () => {
  const prefix = `rfl-test-out-${Date.now()}`;
  const redis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("formata, divide e manda para o chat certo (e para o dono)", async () => {
    const { transport, sent } = fakeTransport();
    const sentTo: string[] = [];
    const worker = startOutbound({
      redis,
      transport,
      ownerChatId: "5511900000002@s.whatsapp.net",
      logger,
      maxPerMinute: 100,
      prefix,
      onSent: (chatId) => sentTo.push(chatId),
    });
    const queue = new Queue<WhatsappOutJob>(QUEUES.whatsappOut, { connection: redis, prefix });
    try {
      await queue.add("reply", { to: { kind: "chat", chatId: "123@lid" }, text: "**Oi!**" });
      await queue.add("owner", { to: { kind: "owner" }, text: "aviso" });
      await queue.add("long", { to: { kind: "chat", chatId: "123@lid" }, text: "x".repeat(4500) });

      await vi.waitFor(() => expect(sent).toHaveLength(4), { timeout: 5000, interval: 50 });
      expect(sent[0]).toEqual(["123@lid", "*Oi!*"]);
      expect(sent[1]).toEqual(["5511900000002@s.whatsapp.net", "aviso"]);
      expect(sent[2]?.[1]).toHaveLength(4000);
      expect(sent[3]?.[1]).toHaveLength(500);
      expect(sentTo).toContain("123@lid");
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("espera o WhatsApp reconectar e tenta de novo", async () => {
    const { transport, sent } = fakeTransport(false);
    const worker = startOutbound({
      redis,
      transport,
      ownerChatId: "x@s.whatsapp.net",
      logger,
      maxPerMinute: 100,
      prefix: `${prefix}-retry`,
    });
    const queue = new Queue<WhatsappOutJob>(QUEUES.whatsappOut, {
      connection: redis,
      prefix: `${prefix}-retry`,
    });
    try {
      await queue.add(
        "reply",
        { to: { kind: "chat", chatId: "123@lid" }, text: "depois" },
        { attempts: 5, backoff: { type: "fixed", delay: 100 } },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sent).toEqual([]);
      transport.connected = true;
      await vi.waitFor(() => expect(sent).toEqual([["123@lid", "depois"]]), {
        timeout: 5000,
        interval: 50,
      });
    } finally {
      await worker.close();
      await queue.close();
    }
  });
});

describe("TypingManager", () => {
  it("renova o digitando até parar, e para sozinho no limite", async () => {
    vi.useFakeTimers();
    try {
      const { transport, typing } = fakeTransport();
      const manager = new TypingManager(transport, logger, { refreshMs: 1000, maxMs: 2500 });

      manager.set("chat", true);
      manager.set("chat", true); // repetido não duplica
      await vi.advanceTimersByTimeAsync(1000);
      expect(typing.filter(([, value]) => value)).toHaveLength(2);

      manager.set("chat", false);
      expect(typing.at(-1)).toEqual(["chat", false]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(typing.filter(([, value]) => value)).toHaveLength(2);

      manager.set("outro", true);
      await vi.advanceTimersByTimeAsync(4000);
      expect(typing.at(-1)).toEqual(["outro", false]);
    } finally {
      vi.useRealTimers();
    }
  });
});
