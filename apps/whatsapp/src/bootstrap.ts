import { PROVIDERS } from "@rfl-bot/contracts";
import { Channel, type Db } from "@rfl-bot/db";

/**
 * Na primeira vez: cria o workspace "Pessoal", o bot "Assistente" (Claude) e liga
 * o número do bot a ele. Nas próximas, só confere. Devolve o workspace.
 */
export async function ensureDefaults(db: Db, { botPhone }: { botPhone: string }): Promise<string> {
  const workspace =
    (await db.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await db.workspace.create({ data: { name: "Pessoal", slug: "pessoal" } }));

  const binding = await db.channelBinding.findUnique({
    where: { channel_externalId: { channel: Channel.WHATSAPP, externalId: botPhone } },
  });
  if (!binding) {
    const bot =
      (await db.bot.findFirst({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "asc" },
      })) ??
      (await db.bot.create({
        data: {
          workspaceId: workspace.id,
          name: "Assistente",
          provider: "claude",
          model: PROVIDERS.claude.defaultModel,
        },
      }));
    await db.channelBinding.create({
      data: {
        workspaceId: workspace.id,
        channel: Channel.WHATSAPP,
        externalId: botPhone,
        botId: bot.id,
      },
    });
  }
  return workspace.id;
}

/** Bot que atende quem escreve sem @Nome. */
export async function defaultBotId(db: Db, botPhone: string): Promise<string | null> {
  const binding = await db.channelBinding.findUnique({
    where: { channel_externalId: { channel: Channel.WHATSAPP, externalId: botPhone } },
    select: { botId: true },
  });
  return binding?.botId ?? null;
}
