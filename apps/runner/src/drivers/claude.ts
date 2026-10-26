// Adaptado de OpenBot 0.1.11 (src/backend/claude-client.ts), Apache-2.0, com alterações.
// Licença e aviso originais em third_party/openbot-0.1.11/.
//
// Alterações: um processo do CLI por turno (retomando a sessão pelo id) em vez de uma
// sessão aberta por conversa; eventos no formato RuntimeEvent do RFL Bot; resposta final
// = última resposta do Claude; erros de login reconhecidos; sem navegador e sem ferramentas
// próprias (entram na Fase 2).

import { type Options, type Query, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FailureCode, RuntimeEvent } from "@rfl-bot/contracts";
import type { Driver, DriverTurnInput } from "./types";

type QueryFactory = (params: { prompt: string; options: Options }) => Query;

export type ClaudeDriverOptions = {
  /** Caminho do CLI do Claude (o que vem com o Agent SDK ou CLAUDE_PATH). */
  executable: string;
  createQuery?: QueryFactory;
};

export function createClaudeDriver({
  executable,
  createQuery = query,
}: ClaudeDriverOptions): Driver {
  return {
    id: "claude",
    async *runTurn(input: DriverTurnInput): AsyncIterable<RuntimeEvent> {
      if (input.signal.aborted) {
        yield interrupted();
        return;
      }
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      input.signal.addEventListener("abort", onAbort, { once: true });

      const state = new ClaudeTurnState();
      let claudeQuery: Query | undefined;
      try {
        claudeQuery = createQuery({
          prompt: input.input,
          options: buildOptions(input, executable, abortController),
        });
        for await (const message of claudeQuery) {
          if (input.signal.aborted) break;
          yield* state.handle(message);
          if (state.finished) break;
        }
        if (!state.finished) {
          yield input.signal.aborted
            ? interrupted()
            : failed("o Claude terminou sem responder", "provider_error");
        }
      } catch (error) {
        yield input.signal.aborted ? interrupted() : failedFromError(error);
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        claudeQuery?.close();
      }
    },
  };
}

function buildOptions(
  input: DriverTurnInput,
  executable: string,
  abortController: AbortController,
): Options {
  return {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: executable,
    model: normalizeClaudeModel(input.model),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.session.resume ? { resume: input.session.id } : { sessionId: input.session.id }),
    systemPrompt: { type: "preset", preset: "claude_code", append: input.instructions },
    settingSources: ["user", "project", "local"],
    // O bot trabalha sozinho dentro do runner, como no OpenBot.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    abortController,
    env: input.env,
  };
}

/**
 * Converte as mensagens do Agent SDK em eventos do RFL Bot.
 * Mesma lógica do OpenBot 0.1.11: texto ao vivo pelos deltas e, como garantia,
 * pelas mensagens completas do assistente.
 */
export class ClaudeTurnState {
  finished = false;
  #text = "";
  readonly #assistantMessages = new Map<string, string>();
  readonly #toolNames = new Map<string, string>();

  *handle(message: SDKMessage): Generator<RuntimeEvent> {
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id !== null) return;
      const event: unknown = message.event;
      const delta = isRecord(event) ? event.delta : null;
      if (
        isRecord(event) &&
        event.type === "content_block_delta" &&
        isRecord(delta) &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        yield* this.#appendDelta(delta.text);
      }
      return;
    }

    if (message.type === "assistant") {
      if (message.parent_tool_use_id !== null) return;
      const content = contentBlocks(message.message);
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "ferramenta";
          this.#toolNames.set(block.id, name);
          yield { type: "tool.started", name, input: block.input };
        }
      }
      const text = messageText(message.message);
      if (!text) return;
      this.#assistantMessages.set(message.uuid, text);
      const completeText = [...this.#assistantMessages.values()].join("\n\n");
      if (completeText.startsWith(this.#text)) {
        yield* this.#appendDelta(completeText.slice(this.#text.length));
      }
      return;
    }

    if (message.type === "user") {
      if (message.parent_tool_use_id !== null) return;
      for (const block of contentBlocks(message.message)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const name = this.#toolNames.get(block.tool_use_id) ?? "ferramenta";
          yield { type: "tool.finished", name, ok: block.is_error !== true };
        }
      }
      return;
    }

    if (message.type !== "result") return;
    this.finished = true;

    const usage: unknown = message.usage;
    if (isRecord(usage)) {
      yield {
        type: "usage",
        inputTokens: numberOr0(usage.input_tokens),
        outputTokens: numberOr0(usage.output_tokens),
      };
    }

    const wasInterrupted =
      message.terminal_reason === "aborted_streaming" ||
      message.terminal_reason === "aborted_tools" ||
      ("errors" in message && message.errors.some((error) => /interrupt|abort/i.test(error)));
    if (wasInterrupted) {
      yield interrupted();
      return;
    }

    if (message.subtype === "success" && !message.is_error) {
      // A última resposta do Claude é o que vai para o canal.
      const finalText = message.result.trim() || this.#text.trim();
      yield { type: "turn.completed", finalText };
      return;
    }

    const errors =
      "errors" in message && message.errors.length > 0
        ? message.errors.join("\n")
        : message.subtype === "success"
          ? message.result
          : message.subtype;
    yield failedFromText(errors);
  }

  *#appendDelta(delta: string): Generator<RuntimeEvent> {
    if (!delta) return;
    this.#text += delta;
    yield { type: "text.delta", text: delta };
  }
}

const NOT_SIGNED_IN =
  /not logged in|please run \/login|invalid api key|oauth token|authentication|unauthorized|\b401\b|credentials?/i;
const USAGE_LIMIT = /usage limit|rate limit|limit reached|\b429\b/i;

function failedFromText(text: string): RuntimeEvent {
  if (NOT_SIGNED_IN.test(text)) {
    return failed("o Claude não está logado. Mande /login claude.", "not_signed_in");
  }
  if (USAGE_LIMIT.test(text)) {
    return failed(
      "a assinatura do Claude atingiu o limite de uso. Tente mais tarde.",
      "provider_error",
    );
  }
  return failed(`o Claude respondeu com erro: ${truncate(text, 300)}`, "provider_error");
}

function failedFromError(error: unknown): RuntimeEvent {
  return failedFromText(error instanceof Error ? error.message : String(error));
}

function failed(error: string, code: FailureCode): RuntimeEvent {
  return { type: "turn.failed", error, code };
}

function interrupted(): RuntimeEvent {
  return failed("cancelado", "interrupted");
}

type Block = Record<string, unknown> & { type?: unknown };

function contentBlocks(message: unknown): Block[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  return contentBlocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Aceita "claude-*"; qualquer outra coisa vira o modelo padrão. */
export function normalizeClaudeModel(model: string): string {
  return model.startsWith("claude-") ? model : "claude-opus-5-5";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
