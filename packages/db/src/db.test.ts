import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, pingDb, TurnStatus } from "./index";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const databaseUrl = process.env.DATABASE_URL;

// Precisa de um Postgres com as migrations aplicadas (pnpm services:up && pnpm db:deploy).
describe.skipIf(!databaseUrl)("banco de dados", () => {
  let db: Db;
  const slug = `teste-${Date.now()}`;

  beforeAll(() => {
    db = createDb(databaseUrl as string);
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug } });
    await db.$disconnect();
  });

  it("responde ao ping", async () => {
    await expect(pingDb(db)).resolves.toBeUndefined();
  });

  it("cria bot, conversa e turnos, e acha o próximo da fila na ordem", async () => {
    const workspace = await db.workspace.create({ data: { name: "Teste", slug } });
    const bot = await db.bot.create({
      data: {
        workspaceId: workspace.id,
        name: "Vendedor",
        provider: "claude",
        model: "claude-opus-5-5",
      },
    });
    const conversation = await db.conversation.create({
      data: { botId: bot.id, channel: "WEB" },
    });
    const turn = (queuedAt: Date) =>
      db.turn.create({
        data: {
          botId: bot.id,
          conversationId: conversation.id,
          provider: bot.provider,
          model: bot.model,
          queuedAt,
        },
      });
    const first = await turn(new Date("2026-01-01T10:00:00Z"));
    await turn(new Date("2026-01-01T10:05:00Z"));

    const next = await db.turn.findFirst({
      where: { botId: bot.id, status: TurnStatus.QUEUED },
      orderBy: { queuedAt: "asc" },
    });

    expect(next?.id).toBe(first.id);
    expect(bot.settings).toEqual({});
    expect(bot.status).toBe("IDLE");
  });

  it("guarda bytes do segredo sem alterar", async () => {
    const workspace = await db.workspace.findUniqueOrThrow({ where: { slug } });
    const ciphertext = new Uint8Array([1, 0, 255, 42, 7]);
    const secret = await db.secret.create({
      data: { workspaceId: workspace.id, name: "anthropic", kind: "api_key", ciphertext },
    });
    const loaded = await db.secret.findUniqueOrThrow({ where: { id: secret.id } });
    expect(Array.from(loaded.ciphertext)).toEqual([1, 0, 255, 42, 7]);
  });

  it("apaga tudo em cascata quando o workspace é apagado", async () => {
    const workspace = await db.workspace.findUniqueOrThrow({ where: { slug } });
    await db.workspace.delete({ where: { id: workspace.id } });
    expect(await db.bot.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await db.secret.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });
});
