import { type Logger, type LoggerOptions, pino } from "pino";

export type { Logger };

/** Campos que nunca podem aparecer nos logs. */
const REDACT_PATHS = [
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "req.headers.authorization",
  "req.headers.cookie",
];

export type CreateLoggerOptions = {
  name: string;
  level?: LoggerOptions["level"];
};

/** Logger em JSON (uma linha por evento). Em desenvolvimento, use `| pino-pretty` para ler. */
export function createLogger({ name, level = "info" }: CreateLoggerOptions): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: "[oculto]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
