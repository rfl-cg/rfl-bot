import { describe, expect, it } from "vitest";
import { runtimeEventSchema, turnRequestSchema } from "./runtime";

describe("turnRequestSchema", () => {
  const request = {
    turnId: "cm1turn0000000001",
    botId: "cm1bot00000000001",
    provider: "claude",
    model: "claude-opus-5-5",
    instructions: "Seja breve.",
    session: { id: "0f8fad5b-d9cb-469f-a165-70867728950e", resume: false },
    input: "oi",
  };

  it("aceita um pedido válido", () => {
    expect(turnRequestSchema.parse(request)).toMatchObject({ provider: "claude" });
  });

  it("recusa id de bot que poderia virar caminho de pasta", () => {
    expect(turnRequestSchema.safeParse({ ...request, botId: "../../etc" }).success).toBe(false);
  });

  it("recusa provedor desconhecido", () => {
    expect(turnRequestSchema.safeParse({ ...request, provider: "x" }).success).toBe(false);
  });
});

describe("runtimeEventSchema", () => {
  it("lê os tipos de evento", () => {
    expect(runtimeEventSchema.parse({ type: "text.delta", text: "Olá" })).toEqual({
      type: "text.delta",
      text: "Olá",
    });
    expect(
      runtimeEventSchema.parse({ type: "turn.failed", error: "sem login", code: "not_signed_in" }),
    ).toMatchObject({ code: "not_signed_in" });
  });

  it("recusa evento desconhecido", () => {
    expect(runtimeEventSchema.safeParse({ type: "outro" }).success).toBe(false);
  });
});
