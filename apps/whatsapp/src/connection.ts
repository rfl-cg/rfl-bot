import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@rfl-bot/core";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { WhatsAppTransport } from "./transport";

export type ConnectionStatus =
  | { state: "connecting" }
  | { state: "pairing"; pairingCode: string }
  | { state: "open" }
  | { state: "closed"; reason: number | null }
  | { state: "logged_out" };

export type WhatsAppConnectionOptions = {
  /** Pasta onde a sessão fica salva (volume). */
  authDir: string;
  /** Número do bot, só dígitos, para o código de pareamento. */
  phone: string;
  logger: Logger;
  onMessages: (messages: WAMessage[]) => void;
  onStatus: (status: ConnectionStatus) => void;
};

const PAIRING_CODE_EVERY_MS = 50_000;

/**
 * Conexão WhatsApp Web (Baileys). Pareia por código, guarda a sessão em disco
 * e reconecta sozinha. Se o WhatsApp desconectar o aparelho, apaga a sessão
 * e mostra um código novo.
 */
export function startWhatsAppConnection(options: WhatsAppConnectionOptions): {
  transport: WhatsAppTransport;
  close: () => Promise<void>;
} {
  const { authDir, phone, logger, onMessages, onStatus } = options;
  const baileysLogger = logger.child({ module: "baileys" });
  baileysLogger.level = "warn";

  let sock: WASocket | undefined;
  let connected = false;
  let closing = false;
  let retries = 0;
  let lastPairingAt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const scheduleReconnect = (delayMs: number) => {
    if (closing) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connect(), delayMs);
  };

  const connect = async (): Promise<void> => {
    if (closing) return;
    onStatus({ state: "connecting" });
    try {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const latest = await fetchLatestBaileysVersion().catch(() => null);
      const socket = makeWASocket({
        auth: state,
        ...(latest ? { version: latest.version } : {}),
        logger: baileysLogger,
        browser: Browsers.ubuntu("RFL Bot"),
        // Deixa as notificações chegando no celular do bot.
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      sock = socket;

      socket.ev.on("creds.update", saveCreds);
      socket.ev.on("messages.upsert", ({ messages, type }) => {
        if (type === "notify") onMessages(messages);
      });
      socket.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (
          qr &&
          !socket.authState.creds.registered &&
          Date.now() - lastPairingAt > PAIRING_CODE_EVERY_MS
        ) {
          lastPairingAt = Date.now();
          socket
            .requestPairingCode(phone)
            .then((pairingCode) => onStatus({ state: "pairing", pairingCode }))
            .catch((error: unknown) =>
              logger.warn({ err: error }, "não consegui pedir o código de pareamento"),
            );
        }

        if (connection === "open") {
          connected = true;
          retries = 0;
          onStatus({ state: "open" });
        }

        if (connection === "close") {
          connected = false;
          if (closing) return;
          const reason =
            (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
              ?.statusCode ?? null;
          if (reason === DisconnectReason.loggedOut) {
            onStatus({ state: "logged_out" });
            void clearSession(authDir).finally(() => scheduleReconnect(5000));
            return;
          }
          onStatus({ state: "closed", reason });
          // Depois de parear, o WhatsApp pede para reiniciar a conexão (515).
          const delay =
            reason === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2000 * 2 ** retries);
          retries += 1;
          scheduleReconnect(delay);
        }
      });
    } catch (error) {
      logger.error({ err: error }, "erro ao conectar no WhatsApp");
      retries += 1;
      scheduleReconnect(Math.min(60_000, 2000 * 2 ** retries));
    }
  };

  void connect();

  const requireSocket = (): WASocket => {
    if (!sock || !connected) throw new Error("WhatsApp desconectado");
    return sock;
  };

  return {
    transport: {
      get connected() {
        return connected;
      },
      async sendText(chatId, text) {
        await requireSocket().sendMessage(chatId, { text });
      },
      async setTyping(chatId, typing) {
        if (!sock || !connected) return;
        await sock.sendPresenceUpdate(typing ? "composing" : "paused", chatId);
      },
      async markRead(incoming) {
        if (!sock || !connected) return;
        await sock.readMessages([incoming.key]);
      },
    },
    async close() {
      closing = true;
      clearTimeout(reconnectTimer);
      sock?.end(undefined);
    },
  };
}

/** Apaga a sessão salva (o aparelho foi desconectado no celular). */
async function clearSession(authDir: string): Promise<void> {
  const files = await readdir(authDir).catch(() => []);
  await Promise.all(files.map((file) => rm(join(authDir, file), { recursive: true, force: true })));
}

/** Conexão desligada (WHATSAPP_CONNECT=false): nada sai; os envios esperam na fila. */
export function offlineConnection(): { transport: WhatsAppTransport; close: () => Promise<void> } {
  return {
    transport: {
      connected: false,
      async sendText() {
        throw new Error("WhatsApp desligado (WHATSAPP_CONNECT=false)");
      },
      async setTyping() {},
      async markRead() {},
    },
    async close() {},
  };
}
