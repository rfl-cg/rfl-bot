import { describe, expect, it } from "vitest";
import { apiEnvSchema, runnerEnvSchema, whatsappEnvSchema, workerEnvSchema } from "./env";

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
  const worker = { ...valid, RUNNER_TOKEN: "c".repeat(32) };

  it("usa batimento de 30 segundos e 2 turnos simultâneos por padrão", () => {
    const env = workerEnvSchema.parse(worker);
    expect(env.WORKER_HEARTBEAT_MS).toBe(30_000);
    expect(env.MAX_CONCURRENT_TURNS).toBe(2);
    expect(env.RUNNER_URL).toBe("http://localhost:4000");
  });

  it("aceita rediss:// (Redis com TLS)", () => {
    expect(workerEnvSchema.safeParse({ ...worker, REDIS_URL: "rediss://host:6380" }).success).toBe(
      true,
    );
  });

  it("exige o token do runner", () => {
    expect(workerEnvSchema.safeParse(valid).success).toBe(false);
  });
});

describe("runnerEnvSchema", () => {
  const token = "a".repeat(32);

  it("não exige banco, Redis nem chave de criptografia", () => {
    const env = runnerEnvSchema.parse({ RUNNER_TOKEN: token });
    expect(env).toMatchObject({
      RUNNER_PORT: 4000,
      RUNNER_DATA_DIR: "/data",
      RUNNER_ENABLE_ECHO: false,
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
  });

  it("recusa token curto", () => {
    expect(runnerEnvSchema.safeParse({ RUNNER_TOKEN: "curto" }).success).toBe(false);
  });

  it("lê RUNNER_ENABLE_ECHO como booleano", () => {
    expect(
      runnerEnvSchema.parse({ RUNNER_TOKEN: token, RUNNER_ENABLE_ECHO: "true" }).RUNNER_ENABLE_ECHO,
    ).toBe(true);
  });
});

describe("whatsappEnvSchema", () => {
  const base = {
    ...valid,
    RUNNER_TOKEN: "b".repeat(32),
    WHATSAPP_PHONE: "+55 (11) 99999-0000",
    WHATSAPP_OWNER: "5511988887777",
  };

  it("limpa os telefones e aceita lista vazia de liberados", () => {
    const env = whatsappEnvSchema.parse(base);
    expect(env.WHATSAPP_PHONE).toBe("5511999990000");
    expect(env.WHATSAPP_ALLOWED).toEqual([]);
  });

  it("separa a lista de números liberados", () => {
    const env = whatsappEnvSchema.parse({
      ...base,
      WHATSAPP_ALLOWED: "5511911112222, +55 21 93333-4444",
    });
    expect(env.WHATSAPP_ALLOWED).toEqual(["5511911112222", "5521933334444"]);
  });

  it("recusa telefone sem DDI", () => {
    expect(whatsappEnvSchema.safeParse({ ...base, WHATSAPP_OWNER: "9999" }).success).toBe(false);
  });
});
