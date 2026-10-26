import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { entityIdSchema } from "@rfl-bot/contracts";

/** Pasta de trabalho de cada bot: <dataDir>/workspaces/<botId>. */
export async function ensureWorkspace(dataDir: string, botId: string): Promise<string> {
  // O id já foi validado no pedido; conferir de novo evita sair da pasta por engano.
  const id = entityIdSchema.parse(botId);
  const path = join(dataDir, "workspaces", id);
  await mkdir(path, { recursive: true });
  return path;
}
