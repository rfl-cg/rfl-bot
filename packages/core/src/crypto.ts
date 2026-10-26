import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

export class SecretBoxError extends Error {
  override name = "SecretBoxError";
}

export type SecretBox = {
  /**
   * Criptografa um segredo (ex.: chave de API).
   * `context` amarra o resultado ao seu dono (ex.: `secret:<workspaceId>:anthropic`):
   * o mesmo valor copiado para outra linha do banco não abre.
   */
  encrypt(plaintext: string, context: string): Uint8Array<ArrayBuffer>;
  decrypt(payload: Uint8Array, context: string): string;
};

/**
 * AES-256-GCM. Formato: [versão 1 byte][iv 12 bytes][tag 16 bytes][conteúdo].
 * `base64Key` é a ENCRYPTION_KEY (32 bytes em base64).
 */
export function createSecretBox(base64Key: string): SecretBox {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new SecretBoxError("ENCRYPTION_KEY deve ter 32 bytes em base64");
  }

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const content = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const out = new Uint8Array(HEADER_LENGTH + content.length);
      out[0] = FORMAT_VERSION;
      out.set(iv, 1);
      out.set(tag, 1 + IV_LENGTH);
      out.set(content, HEADER_LENGTH);
      return out;
    },

    decrypt(payload, context) {
      if (payload.length < HEADER_LENGTH || payload[0] !== FORMAT_VERSION) {
        throw new SecretBoxError("Segredo em formato desconhecido");
      }
      const iv = payload.subarray(1, 1 + IV_LENGTH);
      const tag = payload.subarray(1 + IV_LENGTH, HEADER_LENGTH);
      const content = payload.subarray(HEADER_LENGTH);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(content), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretBoxError("Não foi possível abrir o segredo (chave ou contexto errado)");
      }
    },
  };
}
