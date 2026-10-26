import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LoginCodeResponse, LoginStartResponse, ProviderStatus } from "@rfl-bot/contracts";
import { REDIS_CHANNELS } from "@rfl-bot/contracts";
import { createLogger } from "@rfl-bot/core";
import { createDb, type Db } from "@rfl-bot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultBotId, ensureDefaults } from "../src/bootstrap";
import { type CommandContext, HELP, runCommand } from "../src/commands";
import type { IncomingMessage } from "../src/incoming";
import { handleIncoming, type InboundDeps } from "../src/router";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const databaseUrl = process.env.DATABASE_URL;
const logger = createLogger({ name: "test", level: "silent" });

const OWNER = "5511900000002";
const FRIEND = "5511911112222";

/** Redis falso: só SET NX e PUBLISH. */
function fakeRedis() {
  const keys = new Set<string>();
  const published: Array<[string, string]> = [];
  return {
    published,
    redis: {
      async set(key: string) {
        if (keys.has(key)) return null;
        keys.add(key);
        return "OK" as const;
      },
      async publish(channel: string, message: string) {
        published.push([channel, message]);
        return 1;
      },
    } as unknown as InboundDeps["redis"],
  };
}

function fakeRunner() {
  const submitted: string[] = [];
  return {
    submitted,
    runner: {
      async providers(): Promise<ProviderStatus[]> {
        return [
          {
            id: "claude",
            displayName: "Claude",
            installed: true,
            version: "2.1",
            signedIn: false,
            account: null,
          },
          {
            id: "echo",
            displayName: "Eco",
            installed: true,
            version: null,
            signedIn: true,
            account: null,
          },
        ];
      },
      async startLogin(): Promise<LoginStartResponse> {
        return {
          loginId: "login-1",
          url: "https://claude.ai/oauth/authorize?x=1",
          needsCode: true,
        };
      },
      async submitLoginCode(
        _provider: string,
        loginId: string,
        code: string,
      ): Promise<LoginCodeResponse> {
        submitted.push(`${loginId}:${code}`);
        return code === "bom"
          ? { signedIn: true, account: { email: "dono@exemplo.com", plan: "max" } }
          : { signedIn: false, account: null, error: "o código não foi aceito." };
      },
    },
  };
}

let counter = 0;
function message(
  phone: string,
  text: string,
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  counter += 1;
  return {
    id: `MSG${Date.now()}${counter}`,
    chatId: `${phone}@s.whatsapp.net`,
    senderPhone: phone,
    senderName: phone === OWNER ? "Dono" : "Amigo",
    text,
    kind: "text",
    timestamp: Math.floor(Date.now() / 1000),
    key: { id: `K${counter}` },
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)("gateway do WhatsApp", () => {
  let db: Db;
  let workspaceId: string;
  // Número do bot exclusivo deste teste, para não misturar com dados de desenvolvimento.
  const botPhone = `55119${String(Date.now()).slice(-8)}`;

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
  });

  beforeEach(async () => {
    await db.channelBinding.deleteMany({ where: { externalId: botPhone } });
    const workspace = await db.workspace.create({
      data: { name: "Teste WhatsApp", slug: `teste-wa-${Date.now()}-${Math.random()}` },
    });
    workspaceId = workspace.id;
    // ensureDefaults usa o primeiro workspace; aqui criamos bot e vínculo direto neste.
    const bot = await db.bot.create({
      data: { workspaceId, name: "Assistente", provider: "echo", model: "eco" },
    });
    await db.channelBinding.create({
      data: { workspaceId, channel: "WHATSAPP", externalId: botPhone, botId: bot.id },
    });
  });

  afterAll(async () => {
    await db.channelBinding.deleteMany({ where: { externalId: botPhone } });
    await db.workspace.deleteMany({ where: { slug: { startsWith: "teste-wa-" } } });
    await db.$disconnect();
  });

  function setup() {
    const replies: Array<[string, string]> = [];
    const fake = fakeRedis();
    const runner = fakeRunner();
    const logins: CommandContext["logins"] = { pending: null };
    const canceled: string[][] = [];
    const deps: InboundDeps = {
      db,
      redis: fake.redis,
      logger,
      rules: { owner: OWNER, allowed: [FRIEND] },
      workspaceId,
      botPhone,
      reply: async (chatId, text) => {
        replies.push([chatId, text]);
      },
      markRead: async () => {},
      runCommand: (incoming, command) =>
        runCommand(
          {
            db,
            runner: runner.runner,
            workspaceId,
            botPhone,
            chatId: incoming.chatId,
            logins,
            whatsappConnected: () => true,
            publishCancel: async (turnIds) => {
              canceled.push(turnIds);
            },
            wake: async () => {},
          },
          command,
        ),
    };
    const lastReply = () => replies.at(-1)?.[1] ?? "";
    const send = async (phone: string, text: string, overrides?: Partial<IncomingMessage>) =>
      handleIncoming(deps, message(phone, text, overrides));
    return { deps, replies, lastReply, send, published: fake.published, runner, logins, canceled };
  }

  async function botByName(name: string) {
    return db.bot.findFirstOrThrow({ where: { workspaceId, name } });
  }

  describe("mensagens", () => {
    it("guarda a mensagem do dono, cria o turno e acorda o worker", async () => {
      const { send, published } = setup();
      expect(await send(OWNER, "oi")).toBe("queued");

      const bot = await botByName("Assistente");
      const turns = await db.turn.findMany({
        where: { botId: bot.id },
        include: { messages: true },
      });
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ status: "QUEUED", provider: "echo", model: "eco" });
      expect(turns[0]?.messages[0]?.content).toMatchObject({
        text: "oi",
        fromOwner: true,
        senderName: "Dono",
      });
      expect(published).toEqual([[REDIS_CHANNELS.turnQueued, JSON.stringify({ botId: bot.id })]]);
    });

    it("várias mensagens seguidas entram no mesmo turno", async () => {
      const { send } = setup();
      await send(OWNER, "oi");
      await send(OWNER, "tudo bem?");
      const bot = await botByName("Assistente");
      const turns = await db.turn.findMany({
        where: { botId: bot.id },
        include: { messages: true },
      });
      expect(turns).toHaveLength(1);
      expect(turns[0]?.messages).toHaveLength(2);
    });

    it("número não liberado é ignorado sem guardar nada", async () => {
      const { send, replies } = setup();
      expect(await send("5511000000000", "oi")).toBe("denied");
      expect(replies).toEqual([]);
      expect(await db.turn.count({ where: { bot: { workspaceId } } })).toBe(0);
    });

    it("número liberado conversa, mas não dá comandos", async () => {
      const { send } = setup();
      expect(await send(FRIEND, "/bots")).toBe("queued");
      const turn = await db.turn.findFirst({
        where: { bot: { workspaceId } },
        include: { messages: true },
      });
      expect(turn?.messages[0]?.content).toMatchObject({ text: "/bots", fromOwner: false });
    });

    it("ignora mensagem repetida e mensagem velha", async () => {
      const { deps } = setup();
      const first = message(OWNER, "oi");
      expect(await handleIncoming(deps, first)).toBe("queued");
      expect(await handleIncoming(deps, first)).toBe("duplicate");
      expect(await handleIncoming(deps, message(OWNER, "antiga", { timestamp: 1_000_000 }))).toBe(
        "old",
      );
    });

    it("@Nome manda para outro bot", async () => {
      const { send, replies } = setup();
      await send(OWNER, "/novo Financeiro | cuida das contas");
      expect(await send(OWNER, "@financeiro quanto gastei?")).toBe("queued");
      const financeiro = await botByName("Financeiro");
      const turn = await db.turn.findFirst({
        where: { botId: financeiro.id },
        include: { messages: true },
      });
      expect(turn?.messages[0]?.content).toMatchObject({ text: "quanto gastei?" });
      expect(await send(OWNER, "@Ninguem oi")).toBe("unknown-bot");
      expect(replies.at(-1)?.[1]).toMatch(/Não conheço o bot @Ninguem/);
    });

    it("mídia sem legenda recebe um aviso", async () => {
      const { send, lastReply } = setup();
      expect(await send(OWNER, "", { kind: "media" })).toBe("media");
      expect(lastReply()).toMatch(/só leio mensagens de texto/);
    });
  });

  describe("comandos do dono", () => {
    it("/ajuda e comando desconhecido", async () => {
      const { send, lastReply } = setup();
      await send(OWNER, "/ajuda");
      expect(lastReply()).toBe(HELP);
      await send(OWNER, "/voar");
      expect(lastReply()).toMatch(/Não conheço o comando \/voar/);
    });

    it("/novo, /bots e /padrao", async () => {
      const { send, lastReply } = setup();
      await send(OWNER, "/novo Vendas | vende os produtos do Hub");
      expect(lastReply()).toMatch(/Bot \*Vendas\* criado/);
      expect((await botByName("Vendas")).instructions).toBe("vende os produtos do Hub");

      await send(OWNER, "/novo Vendas");
      expect(lastReply()).toMatch(/Já existe/);
      await send(OWNER, "/novo nome com espaço");
      expect(lastReply()).toMatch(/uma palavra só/);

      await send(OWNER, "/bots");
      expect(lastReply()).toMatch(/\*Assistente\* ⭐/);
      expect(lastReply()).toMatch(/\*Vendas\* — claude \(claude-opus-5-5\)/);

      await send(OWNER, "/padrao vendas");
      expect(lastReply()).toMatch(/Vendas\* agora atende/);
      expect(await defaultBotId(db, botPhone)).toBe((await botByName("Vendas")).id);
    });

    it("/instrucoes, /modelo e /provedor", async () => {
      const { send, lastReply } = setup();
      await send(OWNER, "/instrucoes Assistente | fale como um pirata");
      expect((await botByName("Assistente")).instructions).toBe("fale como um pirata");

      await send(OWNER, "/provedor Assistente claude");
      expect(await botByName("Assistente")).toMatchObject({
        provider: "claude",
        model: "claude-opus-5-5",
      });

      await send(OWNER, "/modelo Assistente gpt-5");
      expect(lastReply()).toMatch(/começam com claude-/);
      await send(OWNER, "/modelo Assistente claude-sonnet-5-5");
      expect((await botByName("Assistente")).model).toBe("claude-sonnet-5-5");

      await send(OWNER, "/provedor Assistente eco");
      expect(await botByName("Assistente")).toMatchObject({ provider: "echo", model: "eco" });
    });

    it("/login e /codigo", async () => {
      const { send, lastReply, runner, logins } = setup();
      await send(OWNER, "/codigo 123");
      expect(lastReply()).toMatch(/Não há login em andamento/);

      await send(OWNER, "/login claude");
      expect(lastReply()).toMatch(/https:\/\/claude\.ai\/oauth\/authorize\?x=1/);
      expect(logins.pending).toMatchObject({ provider: "claude", loginId: "login-1" });

      await send(OWNER, "/codigo errado");
      expect(lastReply()).toMatch(/não foi aceito/);
      expect(logins.pending).toBeNull();

      await send(OWNER, "/login");
      await send(OWNER, "/codigo bom");
      expect(lastReply()).toBe(
        "✅ *Claude* conectado (dono@exemplo.com, max). Já pode conversar com os bots.",
      );
      expect(runner.submitted).toEqual(["login-1:errado", "login-1:bom"]);
    });

    it("comandos não viram mensagens no banco", async () => {
      const { send } = setup();
      await send(OWNER, "/login claude");
      await send(OWNER, "/codigo segredo");
      expect(await db.message.count({ where: { conversation: { bot: { workspaceId } } } })).toBe(0);
    });

    it("/provedores e /status", async () => {
      const { send, lastReply } = setup();
      await send(OWNER, "/provedores");
      expect(lastReply()).toMatch(/\*Claude\*: ❌ desconectado — mande \/login claude/);
      expect(lastReply()).not.toMatch(/Eco/);
      await send(OWNER, "/status");
      expect(lastReply()).toMatch(/WhatsApp: ✅ conectado/);
    });

    it("/parar cancela a fila e o turno em andamento", async () => {
      const { send, lastReply, canceled } = setup();
      await send(OWNER, "oi");
      const bot = await botByName("Assistente");
      const running = await db.turn.create({
        data: {
          botId: bot.id,
          conversationId: (await db.conversation.findFirstOrThrow({ where: { botId: bot.id } })).id,
          provider: "echo",
          model: "eco",
          status: "RUNNING",
        },
      });

      await send(OWNER, "/parar");
      expect(lastReply()).toMatch(/Parei o \*Assistente\* \(1 em andamento, 1 na fila\)/);
      expect(canceled).toEqual([[running.id]]);
      expect(await db.turn.count({ where: { botId: bot.id, status: "QUEUED" } })).toBe(0);

      await db.turn.update({ where: { id: running.id }, data: { status: "DONE" } });
      await send(OWNER, "/parar Assistente");
      expect(lastReply()).toMatch(/não estava fazendo nada/);
    });

    it("/pausar, /fila e /retomar", async () => {
      const { send, lastReply } = setup();
      await send(OWNER, "/pausar Assistente");
      expect((await botByName("Assistente")).status).toBe("PAUSED");
      await send(OWNER, "oi");
      await send(OWNER, "/fila");
      expect(lastReply()).toMatch(/\*Assistente\*: pausado · 1 na fila/);
      await send(OWNER, "/retomar Assistente");
      expect((await botByName("Assistente")).status).toBe("IDLE");
    });

    it("/nova esquece a sessão deste chat", async () => {
      const { send, lastReply } = setup();
      await send(OWNER, "oi");
      const bot = await botByName("Assistente");
      const conversation = await db.conversation.findFirstOrThrow({ where: { botId: bot.id } });
      await db.providerSession.create({
        data: {
          botId: bot.id,
          conversationId: conversation.id,
          provider: "echo",
          nativeSessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        },
      });

      await send(OWNER, "/nova");
      expect(lastReply()).toMatch(/Conversa nova com \*Assistente\*/);
      expect(await db.providerSession.count({ where: { conversationId: conversation.id } })).toBe(
        0,
      );
    });
  });

  describe("ensureDefaults", () => {
    it("liga um número novo ao primeiro bot e não duplica", async () => {
      const otherPhone = `55219${String(Date.now()).slice(-8)}`;
      try {
        const first = await ensureDefaults(db, { botPhone: otherPhone });
        const again = await ensureDefaults(db, { botPhone: otherPhone });
        expect(again).toBe(first);
        expect(await db.channelBinding.count({ where: { externalId: otherPhone } })).toBe(1);
      } finally {
        await db.channelBinding.deleteMany({ where: { externalId: otherPhone } });
      }
    });
  });
});
