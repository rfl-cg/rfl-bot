import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";

export type Db = PrismaClient;

/** Cria o client do banco. Use um por processo e feche com `db.$disconnect()` ao desligar. */
export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/** Confere se o banco responde. Usado no /ready da API. */
export async function pingDb(db: Db): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}
