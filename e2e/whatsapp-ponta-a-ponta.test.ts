// Ponta a ponta: mensagem chega no gateway → fila do bot → worker → runner (HTTP de
// verdade) → resposta sai pela fila whatsapp-out. Só o celular é falso.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QUEUES, REDIS_CHANNELS, type WhatsappOutJob } from "@rfl-bot/contracts";
import { createLogger } from "@rfl-bot/core";
import { createDb, type Db } from "@rfl-bot/db";
import { createRunnerClient } from "@rfl-bot/runner-client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCliEnv } from "../apps/runner/src/cli-env";
import { createClaudeRuntime, createEchoRuntime } from "../apps/runner/src/providers";
import { buildRunnerServer } from "../apps/runner/src/server";
import { ensureWorkspace } from "../apps/runner/src/workspaces";
import { type CommandContext, runCommand } from "../apps/whatsapp/src/commands";
import type { IncomingMessage } from "../apps/whatsapp/src/incoming";
import { startOutbound } from "../apps/whatsapp/src/outbound";
import { handleIncoming, type InboundDeps } from "../apps/whatsapp/src/router";
import type { WhatsAppTransport } from "../apps/whatsapp/src/transport";
import { executeTurn } from "../apps/worker/src/turns/execute-turn";
import { createTurnNotifier } from "../apps/worker/src/turns/notifier";
import { TurnScheduler } from "../apps/worker/src/turns/scheduler";

const rootEnv = resolve(import.meta.dirname, "../.env");
if ((!process.env.DATABASE_URL || !process.env.REDIS_URL) && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const FAKE_CLAUDE = resolve(import.meta.dirname, "../apps/runner/test/fixtures/fake-claude.sh");
const TOKEN = "e2e".repeat(12);
const OWNER = "5511900000002";
const FRIEND = "5511911112222";
const logger = createLogger({ name: "e2e", level: "silent" });

describe.skipIf(!databaseUrl || !redisUrl)("WhatsApp ponta a ponta", { timeout: 30_000 }, () => {
  const prefix = `rfl-e2e-${Date.now()}`;
  const botPhone = `55319${String(Date.now()).slice(-8)}`;
  let db: Db;
  let redis: Redis;
  let dataDir: string;
  let workspaceId: string;
  let stop: () => Promise<void>;
  let deps: InboundDeps;
  const sent: Array<[string, string]> = [];
  const logins: CommandContext["logins"] = { pending: null };

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    redis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    dataDir = await mkdtemp(join(tmpdir(), "rfl-e2e-"));

    // Runner de verdade (HTTP), com o eco e o Claude falso para o login.
    const home = join(dataDir, "home");
    const cliEnv = buildCliEnv({ home, appVersion: "e2e" });
    const runnerServer = buildRunnerServer({
      logger,
      token: TOKEN,
      runtimes: [
        createClaudeRuntime({ executable: FAKE_CLAUDE, env: cliEnv, home }),
        createEchoRuntime(),
      ],
      maxConcurrentTurns: 2,
      workspace: (botId) => ensureWorkspace(dataDir, botId),
      cliEnv,
    });
    await ensureWorkspace(dataDir, "aquecimento1");
    await runnerServer.listen({ port: 0, host: "127.0.0.1" });
    const address = runnerServer.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const runner = createRunnerClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });

    const workspace = await db.workspace.create({
      data: { name: "E2E", slug: `e2e-${Date.now()}` },
    });
    workspaceId = workspace.id;

    // Worker: fila de turnos + notificador (só deste workspace: os testes dividem o banco).
    const outQueue = new Queue<WhatsappOutJob>(QUEUES.whatsappOut, { connection: redis, prefix });
    const notifier = createTurnNotifier({ queue: outQueue, publisher: redis });
    const scheduler = new TurnScheduler({
      db,
      logger,
      maxConcurrent: 2,
      pollMs: 200,
      workspaceId,
      execute: (turnId, signal) =>
        executeTurn({ db, runner, notifier, logger, turnTimeoutMs: 10_000 }, turnId, signal),
    });
    const subscriber = redis.duplicate();
    subscriber.on("message", () => scheduler.wake());
    await subscriber.subscribe(REDIS_CHANNELS.turnQueued);
    await scheduler.start();

    // Gateway: celular falso + envio pela fila.
    const transport: WhatsAppTransport = {
      connected: true,
      async sendText(chatId, text) {
        sent.push([chatId, text]);
      },
      async setTyping() {},
      async markRead() {},
    };
    const outbound = startOutbound({
      redis,
      transport,
      ownerChatId: `${OWNER}@s.whatsapp.net`,
      logger,
      maxPerMinute: 100,
      prefix,
    });

    const bot = await db.bot.create({
      data: { workspaceId, name: "Assistente", provider: "echo", model: "eco" },
    });
    await db.channelBinding.create({
      data: { workspaceId, channel: "WHATSAPP", externalId: botPhone, botId: bot.id },
    });

    const reply = async (chatId: string, text: string) => {
      await outQueue.add("reply", { to: { kind: "chat", chatId }, text });
    };
    deps = {
      db,
      redis,
      logger,
      rules: { owner: OWNER, allowed: [FRIEND] },
      workspaceId,
      botPhone,
      reply,
      markRead: async () => {},
      runCommand: (incoming, command) =>
        runCommand(
          {
            db,
            runner,
            workspaceId,
            botPhone,
            chatId: incoming.chatId,
            logins,
            whatsappConnected: () => true,
            publishCancel: async (turnIds) => {
              await redis.publish(REDIS_CHANNELS.turnCancel, JSON.stringify({ turnIds }));
            },
            wake: async (botId) => {
              await redis.publish(REDIS_CHANNELS.turnQueued, JSON.stringify({ botId }));
            },
          },
          command,
        ),
    };

    stop = async () => {
      await scheduler.stop();
      await outbound.close();
      await outQueue.obliterate({ force: true }).catch(() => {});
      await outQueue.close();
      await subscriber.quit();
      await runnerServer.close();
    };
  });

  afterAll(async () => {
    await stop?.();
    await db?.channelBinding.deleteMany({ where: { externalId: botPhone } });
    await db?.workspace.deleteMany({ where: { id: workspaceId } });
    await db?.$disconnect();
    await redis?.quit();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  let counter = 0;
  const incoming = (phone: string, text: string): IncomingMessage => {
    counter += 1;
    return {
      id: `E2E${Date.now()}${counter}`,
      chatId: `${phone}@s.whatsapp.net`,
      senderPhone: phone,
      senderName: phone === OWNER ? "Dono" : "Amigo",
      text,
      kind: "text",
      timestamp: Math.floor(Date.now() / 1000),
      key: { id: `K${counter}` },
    };
  };
  const repliesTo = (phone: string) =>
    sent.filter(([chatId]) => chatId === `${phone}@s.whatsapp.net`).map(([, text]) => text);

  it("o dono manda uma mensagem e recebe a resposta do bot", async () => {
    expect(await handleIncoming(deps, incoming(OWNER, "oi, tudo bem?"))).toBe("queued");

    await vi.waitFor(() => expect(repliesTo(OWNER)).toContain("Eco: oi, tudo bem?"), {
      timeout: 10_000,
      interval: 50,
    });
    const turn = await db.turn.findFirstOrThrow({
      where: { bot: { workspaceId } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    expect(turn.status).toBe("DONE");
    expect(turn.messages.map((message) => message.role)).toEqual(["USER", "BOT"]);
    expect(await db.providerSession.count({ where: { botId: turn.botId } })).toBe(1);
  });

  it("um amigo liberado conversa com o bot pelo nome", async () => {
    expect(await handleIncoming(deps, incoming(FRIEND, "@Assistente quero um orçamento"))).toBe(
      "queued",
    );
    await vi.waitFor(
      () =>
        expect(repliesTo(FRIEND)).toContain(
          "Eco: [Mensagem de Amigo (+5511911112222)]\nquero um orçamento",
        ),
      { timeout: 10_000, interval: 50 },
    );
  });

  it("o dono conecta o Claude pelo WhatsApp (/login e /codigo)", async () => {
    await handleIncoming(deps, incoming(OWNER, "/login claude"));
    await vi.waitFor(() => expect(repliesTo(OWNER).at(-1)).toMatch(/Login do Claude/), {
      timeout: 10_000,
      interval: 50,
    });
    expect(repliesTo(OWNER).at(-1)).toMatch(/https:\/\/claude\.ai\/oauth\/authorize/);

    await handleIncoming(deps, incoming(OWNER, "/codigo codigo-certo"));
    await vi.waitFor(() => expect(repliesTo(OWNER).at(-1)).toMatch(/Claude\* conectado/), {
      timeout: 10_000,
      interval: 50,
    });

    await handleIncoming(deps, incoming(OWNER, "/provedores"));
    await vi.waitFor(
      () =>
        expect(repliesTo(OWNER).at(-1)).toMatch(/Claude\*: ✅ conectado \(dono@exemplo.com, max\)/),
      {
        timeout: 10_000,
        interval: 50,
      },
    );
  });
});
