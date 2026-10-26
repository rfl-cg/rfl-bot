import { type ZodType, z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Lê e valida as variáveis de ambiente com um schema Zod.
 * Falha cedo, com a lista do que está faltando ou errado.
 */
export function loadEnv<T extends ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.output<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(`Configuração inválida:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
