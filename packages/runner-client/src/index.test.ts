import type { TurnRequest } from "@rfl-bot/contracts";
import { describe, expect, it } from "vitest";
import { createRunnerClient, RunnerError } from "./index";

const request: TurnRequest = {
  turnId: "cm1turn0000000001",
  botId: "cm1bot00000000001",
  provider: "echo",
  model: "eco",
  instructions: "",
  session: { id: "0f8fad5b-d9cb-469f-a165-70867728950e", resume: false },
  input: "oi",
};

/** fetch falso que devolve o corpo em pedaços, como uma conexão de verdade. */
function fakeFetch(status: number, chunks: string[]): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status },
    );
}

async function collect(iterable: AsyncIterable<unknown>) {
  const items: unknown[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("streamTurn", () => {
  it("junta linhas que chegam quebradas em pedaços", async () => {
    const client = createRunnerClient({
      url: "http://runner:4000/",
      token: "x",
      fetch: fakeFetch(200, [
        '{"type":"text.del',
        'ta","text":"Olá"}\n{"type":"turn.com',
        'pleted","finalText":"Olá"}',
      ]),
    });
    expect(await collect(client.streamTurn(request, new AbortController().signal))).toEqual([
      { type: "text.delta", text: "Olá" },
      { type: "turn.completed", finalText: "Olá" },
    ]);
  });

  it("transforma 429 em runner_busy", async () => {
    const client = createRunnerClient({
      url: "http://runner",
      token: "x",
      fetch: fakeFetch(429, []),
    });
    await expect(
      collect(client.streamTurn(request, new AbortController().signal)),
    ).rejects.toMatchObject({
      code: "runner_busy",
    });
  });

  it("explica quando o runner está fora do ar", async () => {
    const client = createRunnerClient({
      url: "http://runner",
      token: "x",
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    });
    const error = await collect(client.streamTurn(request, new AbortController().signal)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).message).toMatch(/ECONNREFUSED/);
  });

  it("recusa evento inválido", async () => {
    const client = createRunnerClient({
      url: "http://runner",
      token: "x",
      fetch: fakeFetch(200, ['{"type":"x"}\n']),
    });
    await expect(
      collect(client.streamTurn(request, new AbortController().signal)),
    ).rejects.toThrowError(/inválido/);
  });
});
