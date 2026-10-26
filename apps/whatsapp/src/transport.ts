import type { IncomingMessage } from "./incoming";

/** O que o resto do gateway precisa da conexão com o WhatsApp (os testes usam uma falsa). */
export interface WhatsAppTransport {
  readonly connected: boolean;
  sendText(chatId: string, text: string): Promise<void>;
  setTyping(chatId: string, typing: boolean): Promise<void>;
  markRead(incoming: IncomingMessage): Promise<void>;
}
