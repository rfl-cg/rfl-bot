export type AccessRules = {
  /** Telefone do dono (só dígitos). */
  owner: string;
  /** Outros telefones liberados. */
  allowed: string[];
};

export type Access = "owner" | "allowed" | "denied";

/** Só o dono e os números liberados falam com os bots. */
export function accessFor(phone: string | null, rules: AccessRules): Access {
  if (!phone) return "denied";
  if (phone === rules.owner) return "owner";
  return rules.allowed.includes(phone) ? "allowed" : "denied";
}

/** "@Nome resto da mensagem" → { name, text }. */
export function parseMention(text: string): { name: string; text: string } | null {
  const match = text.match(/^@([\p{L}\p{N}_-]{2,30})(?:\s+([\s\S]*))?$/u);
  if (!match?.[1]) return null;
  return { name: match[1], text: (match[2] ?? "").trim() };
}

/** "/comando argumentos" → { name, args }. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([a-zçãõáéíóú]+)(?:\s+([\s\S]*))?$/iu);
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}
