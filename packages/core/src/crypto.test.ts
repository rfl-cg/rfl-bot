import { describe, expect, it } from "vitest";
import { createSecretBox, SecretBoxError } from "./crypto";

const key = Buffer.alloc(32, 1).toString("base64");
const otherKey = Buffer.alloc(32, 2).toString("base64");
const context = "secret:ws_1:anthropic";

describe("createSecretBox", () => {
  it("criptografa e abre de volta", () => {
    const box = createSecretBox(key);
    const sealed = box.encrypt("sk-ant-123", context);
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("sk-ant-123");
    expect(box.decrypt(sealed, context)).toBe("sk-ant-123");
  });

  it("gera um resultado diferente a cada vez (iv aleatório)", () => {
    const box = createSecretBox(key);
    const a = box.encrypt("igual", context);
    const b = box.encrypt("igual", context);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("não abre com outra chave", () => {
    const sealed = createSecretBox(key).encrypt("valor", context);
    expect(() => createSecretBox(otherKey).decrypt(sealed, context)).toThrowError(SecretBoxError);
  });

  it("não abre com outro contexto", () => {
    const box = createSecretBox(key);
    const sealed = box.encrypt("valor", context);
    expect(() => box.decrypt(sealed, "secret:ws_2:anthropic")).toThrowError(SecretBoxError);
  });

  it("detecta conteúdo alterado", () => {
    const box = createSecretBox(key);
    const sealed = box.encrypt("valor", context);
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 0xff;
    expect(() => box.decrypt(sealed, context)).toThrowError(SecretBoxError);
  });

  it("recusa formato desconhecido", () => {
    const box = createSecretBox(key);
    expect(() => box.decrypt(new Uint8Array([9, 1, 2]), context)).toThrowError(SecretBoxError);
  });

  it("recusa chave com tamanho errado", () => {
    expect(() => createSecretBox(Buffer.alloc(16).toString("base64"))).toThrowError(SecretBoxError);
  });
});
