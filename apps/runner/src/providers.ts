import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  type LoginCodeResponse,
  type LoginStartResponse,
  PROVIDERS,
  type ProviderId,
  type ProviderStatus,
} from "@rfl-bot/contracts";
import { createClaudeDriver } from "./drivers/claude";
import { createEchoDriver } from "./drivers/echo";
import type { Driver } from "./drivers/types";
import { LoginError, PtyLoginSession } from "./login/pty-login";

const execFileAsync = promisify(execFile);

/** Tudo o que o runner sabe fazer com um provedor. */
export interface ProviderRuntime {
  readonly id: ProviderId;
  readonly driver: Driver;
  status(): Promise<ProviderStatus>;
  startLogin?(): Promise<LoginStartResponse>;
  submitLoginCode?(loginId: string, code: string): Promise<LoginCodeResponse>;
}

const LOGIN_TTL_MS = 10 * 60_000;

export type ClaudeRuntimeOptions = {
  executable: string;
  /** Ambiente limpo (buildCliEnv). */
  env: Record<string, string>;
  /** HOME dos CLIs: o login do Claude fica em <home>/.claude. */
  home: string;
  driver?: Driver;
};

export function createClaudeRuntime({
  executable,
  env,
  home,
  driver = createClaudeDriver({ executable }),
}: ClaudeRuntimeOptions): ProviderRuntime {
  let login: { id: string; session: PtyLoginSession; timer: NodeJS.Timeout } | undefined;

  const clearLogin = () => {
    if (!login) return;
    clearTimeout(login.timer);
    login.session.cancel();
    login = undefined;
  };

  const run = (args: string[]) =>
    execFileAsync(executable, args, { env, cwd: home, timeout: 10_000, maxBuffer: 256 * 1024 });

  const status = async (): Promise<ProviderStatus> => {
    const base = { id: "claude" as const, displayName: PROVIDERS.claude.displayName };
    let version: string | null = null;
    try {
      version = (await run(["--version"])).stdout.trim().split(/\s+/)[0] ?? null;
    } catch {
      return { ...base, installed: false, version: null, signedIn: false, account: null };
    }
    try {
      const parsed: unknown = JSON.parse((await run(["auth", "status", "--json"])).stdout);
      if (!isRecord(parsed) || parsed.loggedIn !== true) {
        return { ...base, installed: true, version, signedIn: false, account: null };
      }
      return {
        ...base,
        installed: true,
        version,
        signedIn: true,
        account: {
          email: typeof parsed.email === "string" ? parsed.email : null,
          plan: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
        },
      };
    } catch {
      return { ...base, installed: true, version, signedIn: false, account: null };
    }
  };

  return {
    id: "claude",
    driver,
    status,

    async startLogin() {
      clearLogin();
      const session = await PtyLoginSession.start({
        command: executable,
        args: ["auth", "login", "--claudeai"],
        env,
        cwd: home,
        allowedHosts: ["claude.ai", "claude.com", "anthropic.com"],
      });
      const id = randomUUID();
      login = { id, session, timer: setTimeout(clearLogin, LOGIN_TTL_MS) };
      return { loginId: id, url: session.url, needsCode: true };
    },

    async submitLoginCode(loginId, code) {
      if (!login || login.id !== loginId) {
        return {
          signedIn: false,
          account: null,
          error: "esse login expirou. Mande /login claude de novo.",
        };
      }
      const { session } = login;
      try {
        await session.submitCode(code);
      } catch (error) {
        clearLogin();
        const message = error instanceof LoginError ? error.message : "o login falhou";
        return { signedIn: false, account: null, error: message };
      }
      clearLogin();
      const result = await status();
      return result.signedIn
        ? { signedIn: true, account: result.account }
        : {
            signedIn: false,
            account: null,
            error: "o código não foi aceito. Mande /login claude e tente de novo.",
          };
    },
  };
}

export function createEchoRuntime(): ProviderRuntime {
  return {
    id: "echo",
    driver: createEchoDriver(),
    async status() {
      return {
        id: "echo",
        displayName: PROVIDERS.echo.displayName,
        installed: true,
        version: null,
        signedIn: true,
        account: null,
      };
    },
  };
}

/** O CLI do Claude que vem com o Agent SDK (pacote da plataforma). */
export function resolveClaudeExecutable(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  const sdkEntry = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  const require = createRequire(sdkEntry);
  const libc = isMusl() ? "-musl" : "";
  return require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/claude`,
  );
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return !report?.header?.glibcVersionRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
