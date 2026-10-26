import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent } from "@rfl-bot/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeTurnState, createClaudeDriver } from "../src/drivers/claude";
import type { DriverTurnInput } from "../src/drivers/types";

// Mensagens do Agent SDK só com os campos que o driver lê.
const msg = (value: Record<string, unknown>) => value as unknown as SDKMessage;

const delta = (text: string) =>
  msg({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
const assistant = (uuid: string, content: unknown[]) =>
  msg({ type: "assistant", parent_tool_use_id: null, uuid, message: { content } });
const success = (result: string, extra: Record<string, unknown> = {}) =>
  msg({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    usage: { input_tokens: 120, output_tokens: 30 },
    ...extra,
  });
const error = (errors: string[], extra: Record<string, unknown> = {}) =>
  msg({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors,
    usage: {},
    ...extra,
  });

function run(messages: SDKMessage[]): RuntimeEvent[] {
  const state = new ClaudeTurnState();
  return messages.flatMap((message) => [...state.handle(message)]);
}

describe("ClaudeTurnState", () => {
  it("transmite o texto e termina com a última resposta do Claude", () => {
    const events = run([
      delta("Ol"),
      delta("á!"),
      assistant("a1", [{ type: "text", text: "Olá!" }]),
      success("Olá!"),
    ]);
    expect(events).toEqual([
      { type: "text.delta", text: "Ol" },
      { type: "text.delta", text: "á!" },
      { type: "usage", inputTokens: 120, outputTokens: 30 },
      { type: "turn.completed", finalText: "Olá!" },
    ]);
  });

  it("usa a mensagem completa quando não houve delta", () => {
    const events = run([assistant("a1", [{ type: "text", text: "Pronto." }]), success("")]);
    expect(events.at(-1)).toEqual({ type: "turn.completed", finalText: "Pronto." });
  });

  it("informa as ferramentas usadas", () => {
    const events = run([
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      msg({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
      }),
      success("feito"),
    ]);
    expect(events).toContainEqual({ type: "tool.started", name: "Bash", input: { command: "ls" } });
    expect(events).toContainEqual({ type: "tool.finished", name: "Bash", ok: true });
  });

  it("ignora mensagens de subagentes", () => {
    const events = run([
      msg({ ...(delta("x") as object), parent_tool_use_id: "sub" }),
      assistant("a1", [{ type: "text", text: "ok" }]),
      success("ok"),
    ]);
    expect(events.filter((event) => event.type === "text.delta")).toEqual([
      { type: "text.delta", text: "ok" },
    ]);
  });

  it("reconhece quando o CLI não está logado", () => {
    const events = run([error(["Invalid API key · Please run /login"])]);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "not_signed_in" });
  });

  it("reconhece o limite da assinatura", () => {
    const events = run([error(["Claude AI usage limit reached|1761523200"])]);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "provider_error" });
    expect((events.at(-1) as { error: string }).error).toMatch(/limite/);
  });

  it("reconhece um turno cancelado", () => {
    const events = run([error([], { terminal_reason: "aborted_streaming" })]);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "interrupted" });
  });
});

function input(overrides: Partial<DriverTurnInput> = {}): DriverTurnInput {
  return {
    cwd: "/data/workspaces/bot1",
    model: "claude-opus-5-5",
    instructions: "Seja breve.",
    session: { id: "0f8fad5b-d9cb-469f-a165-70867728950e", resume: false },
    input: "oi",
    env: { HOME: "/data/home", PATH: "/usr/bin" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function fakeQuery(messages: SDKMessage[], onOptions?: (options: Options) => void) {
  let closed = false;
  const factory = ({ options }: { prompt: string; options: Options }) => {
    onOptions?.(options);
    async function* generate() {
      for (const message of messages) {
        if (options.abortController?.signal.aborted) throw new Error("aborted");
        yield message;
      }
    }
    const generator = generate() as Query;
    generator.close = () => {
      closed = true;
    };
    return generator;
  };
  return { factory, wasClosed: () => closed };
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("createClaudeDriver", () => {
  it("cria sessão nova com o id dado e o ambiente limpo", async () => {
    let seen: Options | undefined;
    const { factory, wasClosed } = fakeQuery([success("oi!")], (options) => {
      seen = options;
    });
    const driver = createClaudeDriver({ executable: "/bin/claude", createQuery: factory });

    const events = await collect(driver.runTurn(input({ effort: "high" })));

    expect(events.at(-1)).toEqual({ type: "turn.completed", finalText: "oi!" });
    expect(seen).toMatchObject({
      cwd: "/data/workspaces/bot1",
      pathToClaudeCodeExecutable: "/bin/claude",
      model: "claude-opus-5-5",
      effort: "high",
      sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      env: { HOME: "/data/home", PATH: "/usr/bin" },
      systemPrompt: { type: "preset", preset: "claude_code", append: "Seja breve." },
    });
    expect(seen).not.toHaveProperty("resume");
    expect(wasClosed()).toBe(true);
  });

  it("retoma a sessão existente", async () => {
    let seen: Options | undefined;
    const { factory } = fakeQuery([success("de volta")], (options) => {
      seen = options;
    });
    const driver = createClaudeDriver({ executable: "/bin/claude", createQuery: factory });

    await collect(
      driver.runTurn(
        input({ session: { id: "0f8fad5b-d9cb-469f-a165-70867728950e", resume: true } }),
      ),
    );

    expect(seen?.resume).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(seen).not.toHaveProperty("sessionId");
  });

  it("troca modelo desconhecido pelo padrão", async () => {
    let seen: Options | undefined;
    const { factory } = fakeQuery([success("ok")], (options) => {
      seen = options;
    });
    await collect(
      createClaudeDriver({ executable: "/bin/claude", createQuery: factory }).runTurn(
        input({ model: "gpt-qualquer" }),
      ),
    );
    expect(seen?.model).toBe("claude-opus-5-5");
  });

  it("devolve falha quando o SDK lança erro", async () => {
    const driver = createClaudeDriver({
      executable: "/bin/claude",
      createQuery: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const events = await collect(driver.runTurn(input()));
    expect(events).toEqual([
      {
        type: "turn.failed",
        error: "o Claude respondeu com erro: spawn ENOENT",
        code: "provider_error",
      },
    ]);
  });

  it("devolve cancelado quando o turno é abortado", async () => {
    const abort = new AbortController();
    abort.abort();
    const { factory } = fakeQuery([success("tarde demais")]);
    const events = await collect(
      createClaudeDriver({ executable: "/bin/claude", createQuery: factory }).runTurn(
        input({ signal: abort.signal }),
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "interrupted" });
  });

  it("avisa quando o fluxo acaba sem resultado", async () => {
    const { factory } = fakeQuery([delta("meio")]);
    const events = await collect(
      createClaudeDriver({ executable: "/bin/claude", createQuery: factory }).runTurn(input()),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "provider_error" });
  });
});
