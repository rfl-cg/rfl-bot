import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runnerEnvSchema } from "@rfl-bot/contracts";
import { createLogger, createShutdown, installShutdownHandlers, loadEnv } from "@rfl-bot/core";
import { buildCliEnv } from "./cli-env";
import {
  createClaudeRuntime,
  createEchoRuntime,
  type ProviderRuntime,
  resolveClaudeExecutable,
} from "./providers";
import { buildRunnerServer } from "./server";
import { ensureWorkspace } from "./workspaces";

const env = loadEnv(runnerEnvSchema);
const logger = createLogger({ name: "runner", level: env.LOG_LEVEL });

const home = join(env.RUNNER_DATA_DIR, "home");
const cliEnv = buildCliEnv({ home, appVersion: env.APP_VERSION });

const runtimes: ProviderRuntime[] = [
  createClaudeRuntime({ executable: resolveClaudeExecutable(env.CLAUDE_PATH), env: cliEnv, home }),
];
if (env.RUNNER_ENABLE_ECHO) runtimes.push(createEchoRuntime());

const app = buildRunnerServer({
  logger,
  token: env.RUNNER_TOKEN,
  runtimes,
  maxConcurrentTurns: env.RUNNER_MAX_CONCURRENT_TURNS,
  workspace: (botId) => ensureWorkspace(env.RUNNER_DATA_DIR, botId),
  cliEnv,
});

const shutdown = createShutdown({
  logger,
  closers: [{ name: "http", close: () => app.close() }],
});
installShutdownHandlers(shutdown, logger);

try {
  await mkdir(home, { recursive: true });
  await mkdir(join(env.RUNNER_DATA_DIR, "workspaces"), { recursive: true });
} catch (error) {
  logger.fatal({ err: error, dataDir: env.RUNNER_DATA_DIR }, "sem permissão na pasta de dados");
  process.exit(1);
}
await app.listen({ host: env.RUNNER_HOST, port: env.RUNNER_PORT });
logger.info(
  { version: env.APP_VERSION, providers: runtimes.map((runtime) => runtime.id) },
  "runner no ar",
);
