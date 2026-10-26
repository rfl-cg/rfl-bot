import { setTimeout as sleep } from "node:timers/promises";
import type { Driver } from "./types";

/** Provedor de teste: responde repetindo a mensagem. Só liga com RUNNER_ENABLE_ECHO=true. */
export function createEchoDriver({ delayMs = 50 }: { delayMs?: number } = {}): Driver {
  return {
    id: "echo",
    async *runTurn({ input, signal }) {
      const text = `Eco: ${input}`;
      try {
        await sleep(delayMs, undefined, { signal });
      } catch {
        yield { type: "turn.failed", error: "cancelado", code: "interrupted" };
        return;
      }
      yield { type: "text.delta", text };
      yield { type: "usage", inputTokens: input.length, outputTokens: text.length };
      yield { type: "turn.completed", finalText: text };
    },
  };
}
