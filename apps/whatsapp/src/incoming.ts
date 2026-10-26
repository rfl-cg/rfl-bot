import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isPnUser,
  jidDecode,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageKey,
} from "baileys";

export type IncomingMessage = {
  /** Id da mensagem no WhatsApp. */
  id: string;
  /** Para onde responder (pode ser número@s.whatsapp.net ou um id @lid). */
  chatId: string;
  /** Telefone de quem mandou, só dígitos, quando o WhatsApp informa. */
  senderPhone: string | null;
  senderName: string | null;
  text: string;
  /** "media": áudio, foto, vídeo, documento… sem legenda. */
  kind: "text" | "media";
  /** Segundos desde 1970. */
  timestamp: number;
  key: WAMessageKey;
};

const MEDIA_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "documentWithCaptionMessage",
  "stickerMessage",
  "ptvMessage",
  "contactMessage",
  "contactsArrayMessage",
  "locationMessage",
]);

/** Lê uma mensagem recebida. Devolve null para o que o bot ignora (grupos, status, reações…). */
export function parseIncoming(message: WAMessage): IncomingMessage | null {
  const { key } = message;
  const chatId = key.remoteJid;
  if (!chatId || !key.id || key.fromMe) return null;
  if (
    isJidGroup(chatId) ||
    isJidBroadcast(chatId) ||
    isJidStatusBroadcast(chatId) ||
    chatId.endsWith("@newsletter")
  ) {
    return null;
  }

  const content = normalizeMessageContent(message.message);
  if (!content) return null;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    "";
  const type = getContentType(content);
  const kind = text.trim() ? "text" : type && MEDIA_TYPES.has(type) ? "media" : null;
  if (!kind) return null;

  // Com o novo formato do WhatsApp (LID), o telefone pode vir no campo alternativo.
  const phoneJid = isPnUser(chatId) ? chatId : isPnUser(key.remoteJidAlt) ? key.remoteJidAlt : null;

  return {
    id: key.id,
    chatId,
    senderPhone: phoneJid ? (jidDecode(phoneJid)?.user ?? null) : null,
    senderName: message.pushName?.trim() || null,
    text: text.trim(),
    kind,
    timestamp: Number(message.messageTimestamp ?? 0),
    key,
  };
}
