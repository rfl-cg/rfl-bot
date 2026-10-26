import { z } from "zod";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Chave AES-256: base64 de exatamente 32 bytes. Gere com `openssl rand -base64 32`. */
const encryptionKey = z
  .string()
  .refine(
    (value) => BASE64_PATTERN.test(value) && Buffer.from(value, "base64").length === 32,
    "deve ser base64 de 32 bytes (gere com: openssl rand -base64 32)",
  );

/** Telefone só com dígitos, com DDI (ex.: 5511999998888). Aceita +, espaços e traços. */
export const phoneSchema = z
  .string()
  .transform((value) => value.replace(/\D/g, ""))
  .pipe(z.string().regex(/^\d{10,15}$/, "telefone com DDI e DDD, só números (ex.: 5511999998888)"));

const phoneListSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(/[,;\n]+/)
      .map((item) => item.replace(/\D/g, ""))
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^\d{10,15}$/, "telefones com DDI e DDD, separados por vírgula")));

export const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

/** Variáveis de todos os processos, inclusive o runner. */
export const commonEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: logLevelSchema.default("info"),
  /** Versão em produção (commit do Git). Preenchida no build da imagem Docker. */
  APP_VERSION: z.string().min(1).default("dev"),
});

/** Processos que usam banco, Redis e segredos. O runner NÃO usa. */
export const baseEnvSchema = commonEnvSchema.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  ENCRYPTION_KEY: encryptionKey,
});

const runnerTokenSchema = z
  .string()
  .min(32, "use pelo menos 32 caracteres (gere com: openssl rand -hex 32)");

/** Para quem chama o runner (worker e WhatsApp). */
const runnerAccessSchema = z.object({
  RUNNER_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:4000"),
  RUNNER_TOKEN: runnerTokenSchema,
});

export const apiEnvSchema = baseEnvSchema.extend({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export const workerEnvSchema = baseEnvSchema.extend(runnerAccessSchema.shape).extend({
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Quantos bots podem trabalhar ao mesmo tempo (a VPS é compartilhada). */
  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(16).default(2),
  /** Tempo máximo de um turno antes de ser cancelado. */
  TURN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(15 * 60_000),
});

export const runnerEnvSchema = commonEnvSchema.extend({
  RUNNER_HOST: z.string().min(1).default("0.0.0.0"),
  RUNNER_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  RUNNER_TOKEN: runnerTokenSchema,
  /** Logins dos CLIs (home/) e pastas dos bots (workspaces/). */
  RUNNER_DATA_DIR: z.string().min(1).default("/data"),
  RUNNER_MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(16).default(2),
  /** Caminho do CLI do Claude. Vazio = o que vem com o Agent SDK. */
  CLAUDE_PATH: z.string().min(1).optional(),
  /** Liga o provedor "eco" (repete a mensagem). Só para testes. */
  RUNNER_ENABLE_ECHO: z.stringbool().default(false),
});

export const whatsappEnvSchema = baseEnvSchema.extend(runnerAccessSchema.shape).extend({
  /** Número do bot (o chip pareado com o WhatsApp Web). */
  WHATSAPP_PHONE: phoneSchema,
  /** Seu número: o único que dá comandos (/login, /bots…). */
  WHATSAPP_OWNER: phoneSchema,
  /** Outros números que podem conversar com os bots, separados por vírgula. */
  WHATSAPP_ALLOWED: phoneListSchema,
  WHATSAPP_AUTH_DIR: z.string().min(1).default("/data/whatsapp"),
  /** false = não conecta no WhatsApp (desenvolvimento e testes sem celular). */
  WHATSAPP_CONNECT: z.stringbool().default(true),
  /** Limite de mensagens enviadas por minuto (reduz o risco de bloqueio). */
  WHATSAPP_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(20),
});

export type CommonEnv = z.output<typeof commonEnvSchema>;
export type BaseEnv = z.output<typeof baseEnvSchema>;
export type ApiEnv = z.output<typeof apiEnvSchema>;
export type WorkerEnv = z.output<typeof workerEnvSchema>;
export type RunnerEnv = z.output<typeof runnerEnvSchema>;
export type WhatsappEnv = z.output<typeof whatsappEnvSchema>;
