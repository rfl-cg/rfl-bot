import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

// Códigos de cor e de controle do terminal.
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: precisamos remover os códigos ESC do terminal.
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const URL_IN_TEXT = /https:\/\/[^\s"'<>]+/g;

export class LoginError extends Error {
  override name = "LoginError";
}

export type PtyLoginOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Só aceita links destes domínios (e subdomínios). */
  allowedHosts: string[];
  urlTimeoutMs?: number;
};

/**
 * Login de CLI em servidor sem tela (direção: cli-code-login do OpenBot).
 * O CLI só mostra o campo para colar o código num terminal, então ele roda
 * dentro do `script` (terminal simulado). O link vai para o dono; o código volta.
 * A saída do CLI e o código são segredos: nunca vão para o log.
 */
export class PtyLoginSession {
  readonly url: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<number | null>;

  private constructor(
    url: string,
    child: ChildProcessWithoutNullStreams,
    exit: Promise<number | null>,
  ) {
    this.url = url;
    this.#child = child;
    this.#exit = exit;
  }

  static start({
    command,
    args,
    env,
    cwd,
    allowedHosts,
    urlTimeoutMs = 30_000,
  }: PtyLoginOptions): Promise<PtyLoginSession> {
    const inner = `stty cols 2000 rows 50 2>/dev/null; exec ${shellQuote([command, ...args])}`;
    const child = spawn("script", ["-q", "-f", "-e", "-c", inner, "/dev/null"], {
      cwd,
      env: { ...env, TERM: "xterm-256color", COLUMNS: "2000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });

    return new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const finish = (result: PtyLoginSession | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        if (result instanceof Error) {
          child.kill("SIGKILL");
          reject(result);
        } else {
          resolve(result);
        }
      };
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const url = findCompleteUrl(output, allowedHosts);
        if (url) finish(new PtyLoginSession(url, child, exit));
      };
      const timer = setTimeout(
        () => finish(new LoginError("o CLI não mostrou o link de login a tempo")),
        urlTimeoutMs,
      );
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (error) =>
        finish(new LoginError(`não consegui abrir o CLI: ${error.message}`)),
      );
      void exit.then(() => finish(new LoginError("o CLI fechou sem mostrar o link de login")));
    });
  }

  get exited(): boolean {
    return this.#child.exitCode !== null || this.#child.signalCode !== null;
  }

  /** Manda o código para o CLI e espera ele terminar. Devolve o código de saída. */
  async submitCode(code: string, timeoutMs = 60_000): Promise<number | null> {
    if (this.exited) throw new LoginError("o login já terminou; comece de novo");
    this.#child.stdin.write(`${code.trim()}\r`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        this.cancel();
        resolve(null);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.#exit, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(): void {
    if (!this.exited) this.#child.kill("SIGKILL");
  }
}

/** Acha um link só depois que a linha terminou: um pedaço pode parar no meio do link. */
export function findCompleteUrl(output: string, allowedHosts: string[]): string | null {
  const clean = output.replace(ANSI, "");
  const lines = clean.split(/\r\n|\n|\r/);
  lines.pop(); // a última linha pode estar incompleta
  for (const line of lines) {
    for (const match of line.matchAll(URL_IN_TEXT)) {
      const candidate = match[0].replace(/[).,;]+$/, "");
      if (isAllowedUrl(candidate, allowedHosts)) return candidate;
    }
  }
  return null;
}

function isAllowedUrl(candidate: string, allowedHosts: string[]): boolean {
  try {
    const { hostname, protocol } = new URL(candidate);
    return (
      protocol === "https:" &&
      allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

function shellQuote(parts: string[]): string {
  return parts.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}
