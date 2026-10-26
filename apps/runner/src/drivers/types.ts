import type { Effort, ProviderId, RuntimeEvent } from "@rfl-bot/contracts";

export type DriverTurnInput = {
  /** Pasta de trabalho do bot. */
  cwd: string;
  model: string;
  effort?: Effort;
  instructions: string;
  session: { id: string; resume: boolean };
  input: string;
  env: Record<string, string>;
  signal: AbortSignal;
};

/** Um driver por provedor. Todos devolvem a mesma "língua" de eventos. */
export interface Driver {
  readonly id: ProviderId;
  runTurn(input: DriverTurnInput): AsyncIterable<RuntimeEvent>;
}
