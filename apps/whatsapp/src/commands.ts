import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "@rfl-bot/contracts";
import { BotStatus, Channel, type Db, TurnStatus } from "@rfl-bot/db";
import type { RunnerClient } from "@rfl-bot/runner-client";
import { defaultBotId } from "./bootstrap";

export type PendingLogin = { provider: ProviderId; loginId: string; expiresAt: number };

export type CommandContext = {
  db: Db;
  runner: Pick<RunnerClient, "providers" | "startLogin" | "submitLoginCode">;
  workspaceId: string;
  botPhone: string;
  /** Chat do dono (para /nova). */
  chatId: string;
  publishCancel: (turnIds: string[]) => Promise<void>;
  wake: (botId: string) => Promise<void>;
  whatsappConnected: () => boolean;
  /** Login em andamento (um por vez). */
  logins: { pending: PendingLogin | null };
  now?: () => number;
};

const BOT_NAME = /^[\p{L}\p{N}_-]{2,30}$/u;
const LOGIN_TTL_MS = 10 * 60_000;

export const HELP = `*Comandos do dono*
/bots — lista os bots
/novo Nome | instruções — cria um bot
/padrao Nome — bot que atende quem escreve sem @
/instrucoes Nome | texto — muda a personalidade do bot
/modelo Nome modelo — troca o modelo (ex.: claude-sonnet-5-5)
/provedor Nome claude — troca o provedor
/login claude — conecta a sua assinatura do Claude
/codigo CÓDIGO — termina o login
/provedores — mostra o que está conectado
/fila — o que cada bot está fazendo
/parar [Nome] — cancela o que o bot está fazendo
/pausar Nome · /retomar Nome
/nova [Nome] — conversa nova: o bot esquece este chat
/status — situação geral

Para falar com um bot específico, comece a mensagem com @Nome.`;

/** Executa um comando do dono e devolve a resposta. */
export async function runCommand(
  ctx: CommandContext,
  command: { name: string; args: string },
): Promise<string> {
  switch (command.name) {
    case "ajuda":
    case "help":
    case "comandos":
      return HELP;
    case "bots":
      return listBots(ctx);
    case "novo":
      return createBot(ctx, command.args);
    case "padrao":
    case "padrão":
      return setDefault(ctx, command.args);
    case "instrucoes":
    case "instruções":
      return setInstructions(ctx, command.args);
    case "modelo":
      return setModel(ctx, command.args);
    case "provedor":
      return setProvider(ctx, command.args);
    case "login":
      return startLogin(ctx, command.args);
    case "codigo":
    case "código":
      return submitCode(ctx, command.args);
    case "provedores":
      return listProviders(ctx);
    case "fila":
      return showQueue(ctx);
    case "parar":
      return stopBot(ctx, command.args);
    case "pausar":
      return pauseBot(ctx, command.args, true);
    case "retomar":
      return pauseBot(ctx, command.args, false);
    case "nova":
      return newConversation(ctx, command.args);
    case "status":
      return status(ctx);
    default:
      return `Não conheço o comando /${command.name}. Mande /ajuda para ver a lista.`;
  }
}

async function findBot(ctx: CommandContext, name: string) {
  return ctx.db.bot.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      name: { equals: name.replace(/^@/, ""), mode: "insensitive" },
    },
  });
}

/** Bot pelo nome, ou o padrão quando o nome não foi dado. */
async function botOrDefault(ctx: CommandContext, name: string) {
  if (name) return findBot(ctx, name);
  const id = await defaultBotId(ctx.db, ctx.botPhone);
  return id ? ctx.db.bot.findUnique({ where: { id } }) : null;
}

const notFound = (name: string) => `Não achei o bot *${name}*. Mande /bots para ver a lista.`;

async function listBots(ctx: CommandContext): Promise<string> {
  const bots = await ctx.db.bot.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { turns: { where: { status: TurnStatus.QUEUED } } } } },
  });
  if (bots.length === 0) return "Nenhum bot ainda. Crie com /novo Nome.";
  const defaultId = await defaultBotId(ctx.db, ctx.botPhone);
  const lines = bots.map((bot) => {
    const state = { IDLE: "livre", WORKING: "trabalhando", PAUSED: "pausado" }[bot.status];
    const queued = bot._count.turns > 0 ? ` · ${bot._count.turns} na fila` : "";
    const isDefault = bot.id === defaultId ? " ⭐" : "";
    return `- *${bot.name}*${isDefault} — ${bot.provider} (${bot.model}) · ${state}${queued}`;
  });
  return `*Bots*\n${lines.join("\n")}\n\n⭐ = atende quem escreve sem @`;
}

async function createBot(ctx: CommandContext, args: string): Promise<string> {
  const [rawName = "", ...rest] = args.split("|");
  const name = rawName.trim();
  if (!BOT_NAME.test(name)) {
    return "Use: /novo Nome | instruções\nO nome é uma palavra só (letras, números, - ou _), de 2 a 30 caracteres.";
  }
  if (await findBot(ctx, name)) return `Já existe um bot chamado *${name}*.`;
  const instructions = rest.join("|").trim();
  await ctx.db.bot.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      provider: "claude",
      model: PROVIDERS.claude.defaultModel,
      instructions,
    },
  });
  return `✅ Bot *${name}* criado (Claude, ${PROVIDERS.claude.defaultModel}).\nPara falar com ele, comece a mensagem com @${name}.`;
}

async function setDefault(ctx: CommandContext, name: string): Promise<string> {
  if (!name) return "Use: /padrao Nome";
  const bot = await findBot(ctx, name);
  if (!bot) return notFound(name);
  await ctx.db.channelBinding.upsert({
    where: { channel_externalId: { channel: Channel.WHATSAPP, externalId: ctx.botPhone } },
    create: {
      workspaceId: ctx.workspaceId,
      channel: Channel.WHATSAPP,
      externalId: ctx.botPhone,
      botId: bot.id,
    },
    update: { botId: bot.id },
  });
  return `⭐ *${bot.name}* agora atende quem escreve sem @.`;
}

async function setInstructions(ctx: CommandContext, args: string): Promise<string> {
  const [rawName = "", ...rest] = args.split("|");
  const instructions = rest.join("|").trim();
  if (!rawName.trim() || !instructions)
    return "Use: /instrucoes Nome | o que o bot deve ser e fazer";
  const bot = await findBot(ctx, rawName.trim());
  if (!bot) return notFound(rawName.trim());
  await ctx.db.bot.update({ where: { id: bot.id }, data: { instructions } });
  return `✅ Instruções do *${bot.name}* atualizadas. Valem a partir da próxima mensagem.`;
}

async function setModel(ctx: CommandContext, args: string): Promise<string> {
  const [name = "", model = ""] = args.split(/\s+/);
  if (!name || !model)
    return "Use: /modelo Nome modelo (ex.: /modelo Assistente claude-sonnet-5-5)";
  const bot = await findBot(ctx, name);
  if (!bot) return notFound(name);
  if (bot.provider === "claude" && !/^claude-[a-z0-9.-]{2,60}$/.test(model)) {
    return "Modelos do Claude começam com claude- (ex.: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5).";
  }
  await ctx.db.bot.update({ where: { id: bot.id }, data: { model } });
  return `✅ *${bot.name}* agora usa ${model}.`;
}

function parseProvider(raw: string): ProviderId | null {
  const value = raw.toLowerCase() === "eco" ? "echo" : raw.toLowerCase();
  return (PROVIDER_IDS as readonly string[]).includes(value) ? (value as ProviderId) : null;
}

async function setProvider(ctx: CommandContext, args: string): Promise<string> {
  const [name = "", raw = ""] = args.split(/\s+/);
  const provider = parseProvider(raw);
  if (!name || !provider) return `Use: /provedor Nome ${publicProviders().join("|")}`;
  const bot = await findBot(ctx, name);
  if (!bot) return notFound(name);
  const model = PROVIDERS[provider].defaultModel;
  await ctx.db.bot.update({ where: { id: bot.id }, data: { provider, model } });
  return `✅ *${bot.name}* agora usa ${PROVIDERS[provider].displayName} (${model}). A conversa continua; só o cérebro mudou.`;
}

function publicProviders(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => !("internal" in PROVIDERS[id] && PROVIDERS[id].internal));
}

async function startLogin(ctx: CommandContext, raw: string): Promise<string> {
  const provider = parseProvider(raw || "claude");
  if (!provider || PROVIDERS[provider].signIn !== "paste-code") {
    return `Use: /login ${publicProviders().join("|")}`;
  }
  const now = ctx.now?.() ?? Date.now();
  try {
    const login = await ctx.runner.startLogin(provider);
    ctx.logins.pending = { provider, loginId: login.loginId, expiresAt: now + LOGIN_TTL_MS };
    const { displayName, plans } = PROVIDERS[provider];
    return `🔐 *Login do ${displayName}*
1. Abra o link e entre com a conta que tem a assinatura (${plans}):
${login.url}

2. A página vai mostrar um código. Copie e mande aqui assim:
/codigo SEU_CÓDIGO

O link vale por 10 minutos.`;
  } catch (error) {
    return `⚠️ Não consegui começar o login: ${error instanceof Error ? error.message : "erro"}`;
  }
}

async function submitCode(ctx: CommandContext, code: string): Promise<string> {
  const pending = ctx.logins.pending;
  const now = ctx.now?.() ?? Date.now();
  if (!pending || pending.expiresAt < now) {
    ctx.logins.pending = null;
    return "Não há login em andamento. Mande /login claude.";
  }
  if (!code) return "Use: /codigo SEU_CÓDIGO";
  ctx.logins.pending = null;
  try {
    const result = await ctx.runner.submitLoginCode(pending.provider, pending.loginId, code);
    const name = PROVIDERS[pending.provider].displayName;
    if (!result.signedIn) return `⚠️ ${result.error ?? "o login não deu certo"}`;
    const who = [result.account?.email, result.account?.plan].filter(Boolean).join(", ");
    return `✅ *${name}* conectado${who ? ` (${who})` : ""}. Já pode conversar com os bots.`;
  } catch (error) {
    return `⚠️ Não consegui terminar o login: ${error instanceof Error ? error.message : "erro"}`;
  }
}

async function listProviders(ctx: CommandContext): Promise<string> {
  try {
    const providers = (await ctx.runner.providers()).filter((provider) =>
      publicProviders().includes(provider.id),
    );
    const lines = providers.map((provider) => {
      if (!provider.installed) return `- *${provider.displayName}*: não instalado no runner`;
      if (!provider.signedIn)
        return `- *${provider.displayName}*: ❌ desconectado — mande /login ${provider.id}`;
      const who = [provider.account?.email, provider.account?.plan].filter(Boolean).join(", ");
      return `- *${provider.displayName}*: ✅ conectado${who ? ` (${who})` : ""}`;
    });
    return `*Provedores*\n${lines.join("\n")}`;
  } catch (error) {
    return `⚠️ Não consegui falar com o runner: ${error instanceof Error ? error.message : "erro"}`;
  }
}

async function showQueue(ctx: CommandContext): Promise<string> {
  const bots = await ctx.db.bot.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      name: true,
      status: true,
      turns: {
        where: { status: { in: [TurnStatus.QUEUED, TurnStatus.RUNNING] } },
        select: { status: true },
      },
    },
  });
  const lines = bots.map((bot) => {
    const running = bot.turns.filter((turn) => turn.status === TurnStatus.RUNNING).length;
    const queued = bot.turns.length - running;
    if (bot.status === BotStatus.PAUSED) return `- *${bot.name}*: pausado · ${queued} na fila`;
    if (running === 0 && queued === 0) return `- *${bot.name}*: livre`;
    return `- *${bot.name}*: ${running > 0 ? "trabalhando" : "esperando a vez"} · ${queued} na fila`;
  });
  return `*Fila*\n${lines.join("\n")}`;
}

async function stopBot(ctx: CommandContext, name: string): Promise<string> {
  const bot = await botOrDefault(ctx, name);
  if (!bot) return notFound(name || "padrão");
  const canceled = await ctx.db.turn.updateMany({
    where: { botId: bot.id, status: TurnStatus.QUEUED },
    data: { status: TurnStatus.CANCELED, error: "cancelado pelo dono", endedAt: new Date() },
  });
  const running = await ctx.db.turn.findMany({
    where: { botId: bot.id, status: TurnStatus.RUNNING },
    select: { id: true },
  });
  if (running.length > 0) await ctx.publishCancel(running.map((turn) => turn.id));
  if (running.length === 0 && canceled.count === 0) return `*${bot.name}* não estava fazendo nada.`;
  return `⏹️ Parei o *${bot.name}* (${running.length} em andamento, ${canceled.count} na fila).`;
}

async function pauseBot(ctx: CommandContext, name: string, pause: boolean): Promise<string> {
  if (!name) return pause ? "Use: /pausar Nome" : "Use: /retomar Nome";
  const bot = await findBot(ctx, name);
  if (!bot) return notFound(name);
  await ctx.db.bot.update({
    where: { id: bot.id },
    data: { status: pause ? BotStatus.PAUSED : BotStatus.IDLE },
  });
  if (!pause) await ctx.wake(bot.id);
  return pause
    ? `⏸️ *${bot.name}* pausado. As mensagens ficam na fila até /retomar ${bot.name}.`
    : `▶️ *${bot.name}* voltou a trabalhar.`;
}

async function newConversation(ctx: CommandContext, name: string): Promise<string> {
  const bot = await botOrDefault(ctx, name);
  if (!bot) return notFound(name || "padrão");
  const conversation = await ctx.db.conversation.findUnique({
    where: {
      botId_channel_externalChatId: {
        botId: bot.id,
        channel: Channel.WHATSAPP,
        externalChatId: ctx.chatId,
      },
    },
  });
  if (conversation) {
    await ctx.db.providerSession.deleteMany({ where: { conversationId: conversation.id } });
  }
  return `🆕 Conversa nova com *${bot.name}*. As memórias continuam; o histórico deste chat foi esquecido.`;
}

async function status(ctx: CommandContext): Promise<string> {
  const [running, queued] = await Promise.all([
    ctx.db.turn.count({
      where: { status: TurnStatus.RUNNING, bot: { workspaceId: ctx.workspaceId } },
    }),
    ctx.db.turn.count({
      where: { status: TurnStatus.QUEUED, bot: { workspaceId: ctx.workspaceId } },
    }),
  ]);
  const providers = await listProviders(ctx);
  return `*Status*
- WhatsApp: ${ctx.whatsappConnected() ? "✅ conectado" : "❌ desconectado"}
- Turnos: ${running} rodando, ${queued} na fila

${providers}`;
}
