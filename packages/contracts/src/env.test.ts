import { describe, expect, it } from "vitest";
import { apiEnvSchema, workerEnvSchema } from "./env";

const valid = {
  DATABASE_URL: "postgresql://rflbot:senha@localhost:5432/rflbot",
  REDIS_URL: "redis://localhost:6379",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("apiEnvSchema", () => {
  it("aplica os valores padrão", () => {
    const env = apiEnvSchema.parse(valid);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      API_HOST: "0.0.0.0",
      API_PORT: 3000,
    });
  });

  it("converte a porta de texto para número", () => {
    expect(apiEnvSchema.parse({ ...valid, API_PORT: "8080" }).API_PORT).toBe(8080);
  });

  it("recusa URL de banco que não é Postgres", () => {
    const result = apiEnvSchema.safeParse({ ...valid, DATABASE_URL: "mysql://localhost/x" });
    expect(result.success).toBe(false);
  });

  it("recusa chave de criptografia com tamanho errado", () => {
    const result = apiEnvSchema.safeParse({
      ...valid,
      ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
    });
    expect(result.success).toBe(false);
  });

  it("recusa chave de criptografia que não é base64", () => {
    const result = apiEnvSchema.safeParse({ ...valid, ENCRYPTION_KEY: `${"x".repeat(44)}!` });
    expect(result.success).toBe(false);
  });
});

describe("workerEnvSchema", () => {
  it("usa batimento de 30 segundos por padrão", () => {
    expect(workerEnvSchema.parse(valid).WORKER_HEARTBEAT_MS).toBe(30_000);
  });

  it("aceita rediss:// (Redis com TLS)", () => {
    expect(workerEnvSchema.safeParse({ ...valid, REDIS_URL: "rediss://host:6380" }).success).toBe(
      true,
    );
  });
});
