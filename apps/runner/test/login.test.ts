import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCliEnv } from "../src/cli-env";
import { findCompleteUrl, LoginError, PtyLoginSession } from "../src/login/pty-login";
import { createClaudeRuntime } from "../src/providers";

const FAKE_CLAUDE = resolve(import.meta.dirname, "fixtures/fake-claude.sh");
const NO_URL_CLI = resolve(import.meta.dirname, "fixtures/no-url-cli.sh");
const CLAUDE_HOSTS = ["claude.ai", "claude.com", "anthropic.com"];

describe("findCompleteUrl", () => {
  it("acha o link depois que a linha termina, sem códigos de cor", () => {
    const output =
      "\u001b[1mVisite:\u001b[0m https://claude.ai/oauth/authorize?state=x\r\nCole o código > ";
    expect(findCompleteUrl(output, CLAUDE_HOSTS)).toBe("https://claude.ai/oauth/authorize?state=x");
  });

  it("espera a linha terminar (o link pode vir pela metade)", () => {
    expect(findCompleteUrl("Visite: https://claude.ai/oauth/autho", CLAUDE_HOSTS)).toBeNull();
  });

  it("ignora links de outros domínios", () => {
    expect(findCompleteUrl("https://claude.ai.golpe.com/x\n", CLAUDE_HOSTS)).toBeNull();
    expect(findCompleteUrl("http://claude.ai/x\n", CLAUDE_HOSTS)).toBeNull();
  });

  it("aceita subdomínios do domínio liberado", () => {
    expect(findCompleteUrl("https://console.anthropic.com/oauth.\n", CLAUDE_HOSTS)).toBe(
      "https://console.anthropic.com/oauth",
    );
  });
});

describe("login do Claude pelo terminal simulado", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "rfl-runner-"));
    env = buildCliEnv({ home, appVersion: "teste" });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("mostra o link, aceita o código e fica logado", async () => {
    const runtime = createClaudeRuntime({ executable: FAKE_CLAUDE, env, home });
    expect(await runtime.status()).toMatchObject({
      installed: true,
      version: "9.9.9",
      signedIn: false,
    });

    const login = await runtime.startLogin?.();
    expect(login?.url).toBe(
      "https://claude.ai/oauth/authorize?code=true&client_id=teste&state=abc",
    );

    const result = await runtime.submitLoginCode?.(login?.loginId ?? "", "codigo-certo");
    expect(result).toEqual({
      signedIn: true,
      account: { email: "dono@exemplo.com", plan: "max" },
    });
  });

  it("explica quando o código está errado", async () => {
    const runtime = createClaudeRuntime({ executable: FAKE_CLAUDE, env, home });
    const login = await runtime.startLogin?.();
    const result = await runtime.submitLoginCode?.(login?.loginId ?? "", "codigo-errado");
    expect(result).toMatchObject({ signedIn: false });
    expect(result?.error).toMatch(/não foi aceito/);
  });

  it("recusa um login que não existe mais", async () => {
    const runtime = createClaudeRuntime({ executable: FAKE_CLAUDE, env, home });
    const result = await runtime.submitLoginCode?.("id-velho", "codigo-certo");
    expect(result?.error).toMatch(/expirou/);
  });

  it("um login novo cancela o anterior", async () => {
    const runtime = createClaudeRuntime({ executable: FAKE_CLAUDE, env, home });
    const first = await runtime.startLogin?.();
    const second = await runtime.startLogin?.();
    expect((await runtime.submitLoginCode?.(first?.loginId ?? "", "codigo-certo"))?.error).toMatch(
      /expirou/,
    );
    expect((await runtime.submitLoginCode?.(second?.loginId ?? "", "codigo-certo"))?.signedIn).toBe(
      true,
    );
  });

  it("falha se o CLI não mostra um link do domínio certo", async () => {
    await expect(
      PtyLoginSession.start({
        command: NO_URL_CLI,
        args: [],
        env,
        cwd: home,
        allowedHosts: CLAUDE_HOSTS,
        urlTimeoutMs: 5000,
      }),
    ).rejects.toThrowError(LoginError);
  });

  it("informa CLI ausente como não instalado", async () => {
    const runtime = createClaudeRuntime({ executable: join(home, "nao-existe"), env, home });
    expect(await runtime.status()).toMatchObject({ installed: false, signedIn: false });
  });
});

describe("buildCliEnv", () => {
  it("não deixa passar variáveis do processo do runner", () => {
    const env = buildCliEnv({
      home: "/data/home",
      appVersion: "abc",
      source: {
        PATH: "/usr/bin",
        DATABASE_URL: "postgres://segredo",
        ANTHROPIC_API_KEY: "sk-segredo",
        CLAUDE_CODE_OAUTH_TOKEN: "segredo",
        HTTPS_PROXY: "http://proxy:3128",
      },
    });
    expect(env).toMatchObject({
      HOME: "/data/home",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:3128",
    });
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
    expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(env)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
