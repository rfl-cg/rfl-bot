import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeEvent, TurnRequest } from "@rfl-bot/contracts";
import { createLogger } from "@rfl-bot/core";
import { createDb, type Db, TurnStatus } from "@rfl-bot/db";
import { RunnerError } from "@rfl-bot/runner-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ABORT_REASON, type ExecuteTurnDeps, executeTurn, type TurnNotifier } from "./execute-turn";
import { TurnScheduler } from "./scheduler";

const rootEnv = resolve(import.meta.dirname, "../../../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const databaseUrl = process.env.DATABASE_URL;
const logger = createLogger({ name: "test", level: "silent" });

type Script = (request: TurnRequest, signal: AbortSignal) => AsyncIterable<RuntimeEvent>;

function fakeRunner(script: Script) {
  const requests: TurnRequest[] = [];
  return {
    requests,
    runner: {
      streamTurn(request: TurnRequest, signal: AbortSignal) {
        requests.push(request);
        return script(request, signal);
      },
    },
  };
}

const reply = (text: string): Script =>
  async function* () {
    yield { type: "usage", inputTokens: 10, outputTokens: 5 };
    yield { type: "turn.completed", finalText: text };
  };

function fakeNotifier() {
  const calls = {
    typing: [] as Array<[string, boolean]>,
    reply: [] as Array<[string, string]>,
    owner: [] as string[],
  };
  const notifier: TurnNotifier = {
    async typing(chatId, typing) {
      calls.typing.push([chatId, typing]);
    },
    async reply(chatId, text) {
      calls.reply.push([chatId, text]);
    },
    async owner(text) {
      calls.owner.push(text);
    },
  };
  return { notifier, calls };
}

describe.skipIf(!databaseUrl)("turnos", () => {
  let db: Db;
  const slug = `teste-turnos-${Date.now()}`;
  let workspaceId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    workspaceId = (await db.workspace.create({ data: { name: "Teste", slug } })).id;
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.bot.deleteMany({ where: { workspaceId } });
  });

  async function setup(name = "Assistente", provider = "echo") {
    const bot = await db.bot.create({
      data: { workspaceId, name, provider, model: "eco", instructions: "Seja gentil." },
    });
    const conversation = await db.conversation.create({
      data: {
        botId: bot.id,
        channel: "WHATSAPP",
        externalChatId: `5511999${Math.random()}@s.whatsapp.net`,
      },
    });
    return { bot, conversation };
  }

  async function queueTurn(
    bot: { id: string; provider: string; model: string },
    conversationId: string,
    text: string,
    extra: Record<string, unknown> = { fromOwner: true },
    queuedAt = new Date(),
  ) {
    const turn = await db.turn.create({
      data: { botId: bot.id, conversationId, provider: bot.provider, model: bot.model, queuedAt },
    });
    await db.message.create({
      data: { conversationId, role: "USER", content: { text, ...extra }, turnId: turn.id },
    });
    return turn;
  }

  function deps(script: Script, overrides: Partial<ExecuteTurnDeps> = {}) {
    const runner = fakeRunner(script);
    const notifier = fakeNotifier();
    const value: ExecuteTurnDeps = {
      db,
      runner: runner.runner,
      notifier: notifier.notifier,
      logger,
      turnTimeoutMs: 10_000,
      ...overrides,
    };
    return { deps: value, requests: runner.requests, calls: notifier.calls };
  }

  async function run(turnId: string, d: ExecuteTurnDeps, signal = new AbortController().signal) {
    await db.turn.update({ where: { id: turnId }, data: { status: TurnStatus.RUNNING } });
    return executeTurn(d, turnId, signal);
  }

  describe("executeTurn", () => {
    it("responde, grava a mensagem e começa uma sessão nova", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d, requests, calls } = deps(reply("Olá!"));

      expect(await run(turn.id, d)).toBe("done");

      expect(requests[0]).toMatchObject({
        input: "oi",
        provider: "echo",
        session: { resume: false },
      });
      expect(requests[0]?.instructions).toMatch(/Você é Assistente/);
      expect(requests[0]?.instructions).toMatch(/Seja gentil/);
      expect(calls.reply).toEqual([[conversation.externalChatId, "Olá!"]]);
      expect(calls.typing).toEqual([
        [conversation.externalChatId, true],
        [conversation.externalChatId, false],
      ]);

      const saved = await db.turn.findUniqueOrThrow({ where: { id: turn.id } });
      expect(saved).toMatchObject({ status: "DONE", inputTokens: 10, outputTokens: 5 });
      const botMessage = await db.message.findFirst({ where: { turnId: turn.id, role: "BOT" } });
      expect(botMessage?.content).toEqual({ text: "Olá!" });
      const events = await db.event.findMany({
        where: { turnId: turn.id },
        orderBy: { seq: "asc" },
      });
      expect(events.map((event) => event.type)).toEqual(["usage", "turn.completed"]);
    });

    it("retoma a mesma sessão no turno seguinte", async () => {
      const { bot, conversation } = await setup();
      const { deps: d, requests } = deps(reply("ok"));
      await run((await queueTurn(bot, conversation.id, "um")).id, d);
      await run((await queueTurn(bot, conversation.id, "dois")).id, d);

      expect(requests[1]?.session).toEqual({ id: requests[0]?.session.id, resume: true });
    });

    it("junta várias mensagens do mesmo turno e identifica quem não é o dono", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi", {
        senderName: "Ana",
        senderPhone: "5511988887777",
      });
      await db.message.create({
        data: {
          conversationId: conversation.id,
          role: "USER",
          content: { text: "tudo bem?", senderName: "Ana", senderPhone: "5511988887777" },
          turnId: turn.id,
        },
      });
      const { deps: d, requests } = deps(reply("Tudo!"));
      await run(turn.id, d);

      expect(requests[0]?.input).toBe(
        "[Mensagem de Ana (+5511988887777)]\noi\n\n[Mensagem de Ana (+5511988887777)]\ntudo bem?",
      );
    });

    it("explica para o dono como conectar o provedor", async () => {
      const { bot, conversation } = await setup("Claudio", "claude");
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d, calls } = deps(async function* () {
        yield { type: "turn.failed", error: "sem login", code: "not_signed_in" };
      });

      expect(await run(turn.id, d)).toBe("failed");
      expect(calls.reply[0]?.[1]).toMatch(/\/login claude/);
      expect(calls.owner).toEqual([]);
      expect(await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({
        status: "FAILED",
        error: "sem login",
      });
    });

    it("para outras pessoas manda uma mensagem genérica e avisa o dono", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi", { senderName: "Ana" });
      const { deps: d, calls } = deps(async function* () {
        yield { type: "turn.failed", error: "limite atingido", code: "provider_error" };
      });

      await run(turn.id, d);
      expect(calls.reply[0]?.[1]).toMatch(/não consegui responder agora/);
      expect(calls.reply[0]?.[1]).not.toMatch(/login|limite/);
      expect(calls.owner[0]).toMatch(/Assistente\* não conseguiu responder Ana: limite atingido/);
    });

    it("trata runner fora do ar como falha", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d, calls } = deps(() => {
        throw new RunnerError("runner fora do ar (ECONNREFUSED)", "internal");
      });

      expect(await run(turn.id, d)).toBe("failed");
      expect(calls.reply[0]?.[1]).toMatch(/ECONNREFUSED/);
    });

    it("runner ocupado devolve o turno para a fila", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d, calls } = deps(() => {
        throw new RunnerError("runner ocupado", "runner_busy");
      });

      expect(await run(turn.id, d)).toBe("requeued");
      expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("QUEUED");
      expect(calls.reply).toEqual([]);
    });

    const slow: Script = async function* (_request, signal) {
      await sleep(5000, undefined, { signal }).catch(() => {});
      yield { type: "turn.failed", error: "cancelado", code: "interrupted" };
    };

    it("/parar cancela sem responder", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d, calls } = deps(slow);
      const controller = new AbortController();
      setTimeout(() => controller.abort(ABORT_REASON.cancel), 50);

      expect(await run(turn.id, d, controller.signal)).toBe("canceled");
      expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("CANCELED");
      expect(calls.reply).toEqual([]);
    });

    it("desligamento devolve o turno para a fila", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d } = deps(slow);
      const controller = new AbortController();
      setTimeout(() => controller.abort(ABORT_REASON.shutdown), 50);

      expect(await run(turn.id, d, controller.signal)).toBe("requeued");
      expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("QUEUED");
    });

    it("tempo esgotado falha e avisa no chat", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      const { deps: d, calls } = deps(slow, { turnTimeoutMs: 50 });

      expect(await run(turn.id, d)).toBe("failed");
      expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).error).toBe(
        "tempo esgotado",
      );
      expect(calls.reply[0]?.[1]).toMatch(/demorou demais/);
    });
  });

  describe("TurnScheduler", () => {
    it("cada bot faz um turno por vez, na ordem; bots diferentes em paralelo", async () => {
      const a = await setup("A");
      const b = await setup("B");
      const t0 = Date.now();
      const a1 = await queueTurn(a.bot, a.conversation.id, "a1", undefined, new Date(t0));
      const a2 = await queueTurn(a.bot, a.conversation.id, "a2", undefined, new Date(t0 + 1));
      const b1 = await queueTurn(b.bot, b.conversation.id, "b1", undefined, new Date(t0 + 2));

      const log: string[] = [];
      let concurrent = 0;
      let maxConcurrent = 0;
      const scheduler = new TurnScheduler({
        db,
        logger,
        maxConcurrent: 2,
        pollMs: 60_000,
        execute: async (turnId) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          log.push(`início ${turnId}`);
          await sleep(80);
          await db.turn.update({ where: { id: turnId }, data: { status: "DONE" } });
          log.push(`fim ${turnId}`);
          concurrent -= 1;
        },
      });

      await scheduler.start();
      await vi.waitFor(
        async () => {
          expect(
            await db.turn.count({ where: { id: { in: [a1.id, a2.id, b1.id] }, status: "DONE" } }),
          ).toBe(3);
        },
        { timeout: 5000, interval: 50 },
      );
      await scheduler.stop();

      expect(maxConcurrent).toBe(2);
      expect(log.indexOf(`fim ${a1.id}`)).toBeLessThan(log.indexOf(`início ${a2.id}`));
      expect(log.indexOf(`início ${b1.id}`)).toBeLessThan(log.indexOf(`fim ${a1.id}`));
    });

    it("respeita o limite de bots ao mesmo tempo", async () => {
      const bots = await Promise.all(["X", "Y", "Z"].map((name) => setup(name)));
      for (const { bot, conversation } of bots) await queueTurn(bot, conversation.id, "oi");

      let concurrent = 0;
      let maxConcurrent = 0;
      const scheduler = new TurnScheduler({
        db,
        logger,
        maxConcurrent: 1,
        pollMs: 60_000,
        execute: async (turnId) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(30);
          await db.turn.update({ where: { id: turnId }, data: { status: "DONE" } });
          concurrent -= 1;
        },
      });
      await scheduler.start();
      await vi.waitFor(
        async () => {
          expect(
            await db.turn.count({
              where: { botId: { in: bots.map((b) => b.bot.id) }, status: "DONE" },
            }),
          ).toBe(3);
        },
        { timeout: 5000, interval: 50 },
      );
      await scheduler.stop();
      expect(maxConcurrent).toBe(1);
    });

    it("não pega turnos de bot pausado", async () => {
      const { bot, conversation } = await setup();
      await db.bot.update({ where: { id: bot.id }, data: { status: "PAUSED" } });
      const turn = await queueTurn(bot, conversation.id, "oi");
      const execute = vi.fn(async () => {});
      const scheduler = new TurnScheduler({
        db,
        logger,
        maxConcurrent: 2,
        pollMs: 60_000,
        execute,
      });

      await scheduler.start();
      await sleep(200);
      await scheduler.stop();

      expect(execute).not.toHaveBeenCalled();
      expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("QUEUED");
    });

    it("depois de uma queda, retoma o turno uma vez e depois desiste", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      await db.bot.update({ where: { id: bot.id }, data: { status: "PAUSED" } });
      await db.turn.update({ where: { id: turn.id }, data: { status: "RUNNING" } });

      const scheduler = () =>
        new TurnScheduler({
          db,
          logger,
          maxConcurrent: 1,
          pollMs: 60_000,
          execute: async () => {},
        });

      const first = scheduler();
      await first.start();
      await first.stop();
      expect(await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({
        status: "QUEUED",
        attempts: 1,
      });

      await db.turn.update({ where: { id: turn.id }, data: { status: "RUNNING" } });
      const second = scheduler();
      await second.start();
      await second.stop();
      expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe("FAILED");
    });

    it("cancela um turno em andamento", async () => {
      const { bot, conversation } = await setup();
      const turn = await queueTurn(bot, conversation.id, "oi");
      let reason: unknown;
      const scheduler = new TurnScheduler({
        db,
        logger,
        maxConcurrent: 1,
        pollMs: 60_000,
        execute: async (_turnId, signal) => {
          await sleep(5000, undefined, { signal }).catch(() => {});
          reason = signal.reason;
          await db.turn.update({ where: { id: turn.id }, data: { status: "CANCELED" } });
        },
      });
      await scheduler.start();
      await vi.waitFor(() => expect(scheduler.runningBots).toContain(bot.id), { timeout: 2000 });
      scheduler.cancel([turn.id]);
      await vi.waitFor(() => expect(reason).toBe(ABORT_REASON.cancel), { timeout: 2000 });
      await scheduler.stop();
    });
  });
});
