import type { WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import { accessFor, parseCommand, parseMention } from "../src/access";
import { splitMessage, toWhatsAppText } from "../src/format";
import { parseIncoming } from "../src/incoming";
import { maskPhone } from "../src/router";

describe("toWhatsAppText", () => {
  it("converte negrito, títulos, tachado, listas e links", () => {
    const markdown = [
      "## Resumo",
      "**Total:** 3 pedidos",
      "* um",
      "+ dois",
      "~~velho~~",
      "Veja [o painel](https://exemplo.com/p).",
    ].join("\n");
    expect(toWhatsAppText(markdown)).toBe(
      [
        "*Resumo*",
        "*Total:* 3 pedidos",
        "- um",
        "- dois",
        "~velho~",
        "Veja o painel (https://exemplo.com/p).",
      ].join("\n"),
    );
  });

  it("não mexe dentro de blocos de código nem no negrito do WhatsApp", () => {
    const text = "*já é negrito*\n```\n**não mexer**\n* nem aqui\n```";
    expect(toWhatsAppText(text)).toBe(text);
  });
});

describe("splitMessage", () => {
  it("não divide mensagens curtas", () => {
    expect(splitMessage("oi")).toEqual(["oi"]);
  });

  it("divide entre parágrafos sem perder texto", () => {
    const paragraph = "palavra ".repeat(50).trim();
    const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
    const parts = splitMessage(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("corta texto sem espaços no limite", () => {
    expect(splitMessage("x".repeat(25), 10)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
  });
});

const wa = (value: Record<string, unknown>) => value as unknown as WAMessage;

describe("parseIncoming", () => {
  it("lê texto simples", () => {
    const incoming = parseIncoming(
      wa({
        key: { id: "M1", remoteJid: "5511999998888@s.whatsapp.net", fromMe: false },
        message: { conversation: " Oi bot " },
        pushName: "Rafa",
        messageTimestamp: 1761523200,
      }),
    );
    expect(incoming).toMatchObject({
      id: "M1",
      chatId: "5511999998888@s.whatsapp.net",
      senderPhone: "5511999998888",
      senderName: "Rafa",
      text: "Oi bot",
      kind: "text",
      timestamp: 1761523200,
    });
  });

  it("acha o telefone no campo alternativo quando o chat vem como LID", () => {
    const incoming = parseIncoming(
      wa({
        key: {
          id: "M2",
          remoteJid: "123456789012345@lid",
          remoteJidAlt: "5511988887777@s.whatsapp.net",
          fromMe: false,
        },
        message: { extendedTextMessage: { text: "olá" } },
      }),
    );
    expect(incoming).toMatchObject({ chatId: "123456789012345@lid", senderPhone: "5511988887777" });
  });

  it("usa a legenda de fotos e marca mídia sem legenda", () => {
    expect(
      parseIncoming(
        wa({
          key: { id: "M3", remoteJid: "5511@s.whatsapp.net" },
          message: { imageMessage: { caption: "o que é isso?" } },
        }),
      ),
    ).toMatchObject({ kind: "text", text: "o que é isso?" });
    expect(
      parseIncoming(
        wa({ key: { id: "M4", remoteJid: "5511@s.whatsapp.net" }, message: { audioMessage: {} } }),
      ),
    ).toMatchObject({ kind: "media" });
  });

  it("ignora grupos, status, mensagens minhas e reações", () => {
    const text = { conversation: "oi" };
    expect(
      parseIncoming(wa({ key: { id: "1", remoteJid: "123-456@g.us" }, message: text })),
    ).toBeNull();
    expect(
      parseIncoming(wa({ key: { id: "2", remoteJid: "status@broadcast" }, message: text })),
    ).toBeNull();
    expect(
      parseIncoming(
        wa({ key: { id: "3", remoteJid: "5511@s.whatsapp.net", fromMe: true }, message: text }),
      ),
    ).toBeNull();
    expect(
      parseIncoming(
        wa({
          key: { id: "4", remoteJid: "5511@s.whatsapp.net" },
          message: { reactionMessage: { text: "👍" } },
        }),
      ),
    ).toBeNull();
  });
});

describe("acesso e comandos", () => {
  const rules = { owner: "5511900000002", allowed: ["5511911112222"] };

  it("separa dono, liberados e o resto", () => {
    expect(accessFor("5511900000002", rules)).toBe("owner");
    expect(accessFor("5511911112222", rules)).toBe("allowed");
    expect(accessFor("5511000000000", rules)).toBe("denied");
    expect(accessFor(null, rules)).toBe("denied");
  });

  it("lê @menção", () => {
    expect(parseMention("@Financeiro quanto gastei?")).toEqual({
      name: "Financeiro",
      text: "quanto gastei?",
    });
    expect(parseMention("@Ana")).toEqual({ name: "Ana", text: "" });
    expect(parseMention("oi @Ana")).toBeNull();
  });

  it("lê comandos", () => {
    expect(parseCommand("/novo Vendas | vende bem")).toEqual({
      name: "novo",
      args: "Vendas | vende bem",
    });
    expect(parseCommand("/BOTS")).toEqual({ name: "bots", args: "" });
    expect(parseCommand("/código ABC")).toEqual({ name: "código", args: "ABC" });
    expect(parseCommand("isso não é /comando")).toBeNull();
  });

  it("esconde parte do telefone no log", () => {
    expect(maskPhone("5511999998888")).toBe("55119****8888");
  });
});
