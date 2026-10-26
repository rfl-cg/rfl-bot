/**
 * Ambiente dos CLIs dos provedores. Nada é herdado do processo do runner:
 * só o que está nesta lista passa. Assim nenhuma variável perdida (token,
 * chave, configuração do host) muda o comportamento ou vaza para o bot.
 */
const PASS_THROUGH = [
  "PATH",
  "TZ",
  // Proxy corporativo e certificados, se a VPS usar.
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];

export type CliEnvOptions = {
  /** Pasta onde cada CLI guarda o próprio login (~/.claude, ~/.codex…). */
  home: string;
  appVersion: string;
  source?: Record<string, string | undefined>;
};

export function buildCliEnv({
  home,
  appVersion,
  source = process.env,
}: CliEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    // O runner fixa a versão do CLI; ele não deve se atualizar sozinho.
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: `rfl-bot/${appVersion}`,
  };
  for (const name of PASS_THROUGH) {
    const value = source[name];
    if (value) env[name] = value;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return env;
}
