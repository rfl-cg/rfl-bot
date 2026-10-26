import {
  type FailureCode,
  type LoginCodeResponse,
  type LoginStartResponse,
  loginCodeResponseSchema,
  loginStartResponseSchema,
  type ProviderId,
  type ProviderStatus,
  providerStatusSchema,
  type RuntimeEvent,
  runtimeEventSchema,
  type TurnRequest,
} from "@rfl-bot/contracts";
import { z } from "zod";

export class RunnerError extends Error {
  override name = "RunnerError";
  constructor(
    message: string,
    readonly code: FailureCode,
  ) {
    super(message);
  }
}

export type RunnerClientOptions = {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
};

export type RunnerClient = ReturnType<typeof createRunnerClient>;

/** Cliente do runner, usado pelo worker (turnos) e pelo WhatsApp (login dos provedores). */
export function createRunnerClient({ url, token, fetch = globalThis.fetch }: RunnerClientOptions) {
  const base = url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const call = async <T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new RunnerError(`runner fora do ar (${describe(error)})`, "internal");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String(body.error)
          : response.statusText;
      throw new RunnerError(message, "internal");
    }
    return schema.parse(body);
  };

  return {
    /** Executa um turno e devolve os eventos conforme chegam. */
    async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
      let response: Response;
      try {
        response = await fetch(`${base}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RunnerError(`runner fora do ar (${describe(error)})`, "internal");
      }
      if (response.status === 429) throw new RunnerError("runner ocupado", "runner_busy");
      if (!response.ok || !response.body) {
        throw new RunnerError(`runner respondeu ${response.status}`, "internal");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) yield parseEvent(line);
          newline = buffer.indexOf("\n");
        }
      }
      const rest = (buffer + decoder.decode()).trim();
      if (rest) yield parseEvent(rest);
    },

    providers(): Promise<ProviderStatus[]> {
      return call("/providers", z.array(providerStatusSchema), { method: "GET" });
    },

    startLogin(provider: ProviderId): Promise<LoginStartResponse> {
      return call(`/providers/${provider}/login`, loginStartResponseSchema, { method: "POST" });
    },

    submitLoginCode(
      provider: ProviderId,
      loginId: string,
      code: string,
    ): Promise<LoginCodeResponse> {
      return call(
        `/providers/${provider}/login/${encodeURIComponent(loginId)}/code`,
        loginCodeResponseSchema,
        { method: "POST", body: { code } },
      );
    },
  };
}

function parseEvent(line: string): RuntimeEvent {
  try {
    return runtimeEventSchema.parse(JSON.parse(line));
  } catch {
    throw new RunnerError("o runner mandou um evento inválido", "internal");
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    return cause?.code ?? error.message;
  }
  return String(error);
}
