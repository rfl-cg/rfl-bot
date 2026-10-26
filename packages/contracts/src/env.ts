import { z } from "zod";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Chave AES-256: base64 de exatamente 32 bytes. Gere com `openssl rand -base64 32`. */
const encryptionKey = z
  .string()
  .refine(
    (value) => BASE64_PATTERN.test(value) && Buffer.from(value, "base64").length === 32,
    "deve ser base64 de 32 bytes (gere com: openssl rand -base64 32)",
  );

export const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

/** Variáveis usadas por todos os processos do backend. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: logLevelSchema.default("info"),
  /** Versão em produção (commit do Git). Preenchida no build da imagem Docker. */
  APP_VERSION: z.string().min(1).default("dev"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  ENCRYPTION_KEY: encryptionKey,
});

export const apiEnvSchema = baseEnvSchema.extend({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(30_000),
});

export type BaseEnv = z.output<typeof baseEnvSchema>;
export type ApiEnv = z.output<typeof apiEnvSchema>;
export type WorkerEnv = z.output<typeof workerEnvSchema>;
