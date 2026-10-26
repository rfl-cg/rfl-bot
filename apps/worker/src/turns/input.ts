import { type MessageContent, messageContentSchema } from "@rfl-bot/contracts";

/**
 * Junta as mensagens que dispararam o turno num texto só.
 * Mensagens de outras pessoas (não do dono) levam o nome de quem mandou.
 */
export function buildTurnInput(contents: unknown[]): string {
  const messages = contents
    .map((content) => messageContentSchema.safeParse(content))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter((message) => message.text.trim().length > 0);

  return messages.map(formatMessage).join("\n\n");
}

function formatMessage(message: MessageContent): string {
  if (message.fromOwner || !message.senderName) return message.text.trim();
  const who = message.senderPhone
    ? `${message.senderName} (+${message.senderPhone})`
    : message.senderName;
  return `[Mensagem de ${who}]\n${message.text.trim()}`;
}
