import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, loadEnv } from "./config";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.url(),
});

describe("loadEnv", () => {
  it("devolve os valores validados", () => {
    expect(loadEnv(schema, { DATABASE_URL: "postgres://x/y" })).toEqual({
      PORT: 3000,
      DATABASE_URL: "postgres://x/y",
    });
  });

  it("explica o que está faltando", () => {
    expect(() => loadEnv(schema, {})).toThrowError(ConfigError);
    expect(() => loadEnv(schema, {})).toThrowError(/DATABASE_URL/);
  });
});
