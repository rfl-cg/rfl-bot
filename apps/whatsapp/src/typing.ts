import type { Logger } from "@rfl-bot/core";
import type { WhatsAppTransport } from "./transport";

/**
 * "Digitando…" enquanto o bot trabalha. O WhatsApp apaga o aviso sozinho depois de
 * alguns segundos, então ele é renovado até a resposta sair (ou até um limite).
 */
export class TypingManager {
  readonly #chats = new Map<string, { timer: NodeJS.Timeout; stopAt: number }>();

  constructor(
    private readonly transport: WhatsAppTransport,
    private readonly logger: Logger,
    private readonly options: { refreshMs?: number; maxMs?: number } = {},
  ) {}

  set(chatId: string, typing: boolean): void {
    if (!typing) {
      this.stop(chatId);
      return;
    }
    if (this.#chats.has(chatId)) return;
    const refreshMs = this.options.refreshMs ?? 8000;
    const stopAt = Date.now() + (this.options.maxMs ?? 5 * 60_000);
    const send = () => {
      if (Date.now() > stopAt) {
        this.stop(chatId);
        return;
      }
      this.transport
        .setTyping(chatId, true)
        .catch((error: unknown) => this.logger.debug({ err: error }, "digitando falhou"));
    };
    send();
    this.#chats.set(chatId, { timer: setInterval(send, refreshMs), stopAt });
  }

  stop(chatId: string): void {
    const entry = this.#chats.get(chatId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.#chats.delete(chatId);
    this.transport.setTyping(chatId, false).catch(() => {});
  }

  stopAll(): void {
    for (const chatId of [...this.#chats.keys()]) this.stop(chatId);
  }
}
