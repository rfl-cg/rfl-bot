import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

// Em desenvolvimento, lê o .env da raiz do repositório.
// Em produção e no CI, as variáveis já vêm do ambiente.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
