import { z } from "zod";
import { providerIdSchema } from "./providers";

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof effortSchema>;

/** Ids gerados pelo Prisma (cuid). Também viram nome de pasta, então só letras e números. */
export const entityIdSchema = z.string().regex(/^[a-z0-9]{8,64}$/i, "id inválido");

export const failureCodeSchema = z.enum([
  /** O CLI não está logado: mande /login <provedor>. */
  "not_signed_in",
  /** Cancelado (/parar, tempo esgotado ou desligamento). */
  "interrupted",
  /** O provedor respondeu com erro (limite da assinatura, falha da API…). */
  "provider_error",
  /** O runner já está com o máximo de turnos. */
  "runner_busy",
  "internal",
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

/** Pedido do worker para o runner executar um turno. */
export const turnRequestSchema = z.object({
  turnId: entityIdSchema,
  botId: entityIdSchema,
  provider: providerIdSchema,
  model: z.string().min(1).max(100),
  effort: effortSchema.optional(),
  /** Instruções do bot (personalidade, regras, memórias). */
  instructions: z.string().max(100_000),
  /** Sessão do provedor: nova (resume=false) ou retomada (resume=true). */
  session: z.object({ id: z.uuid(), resume: z.boolean() }),
  input: z.string().min(1).max(200_000),
});
export type TurnRequest = z.infer<typeof turnRequestSchema>;

/** Eventos que o runner devolve, um JSON por linha. Mesma "língua" para todos os provedores. */
export const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  z.object({ type: z.literal("tool.started"), name: z.string(), input: z.unknown().optional() }),
  z.object({ type: z.literal("tool.finished"), name: z.string(), ok: z.boolean() }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("turn.completed"), finalText: z.string() }),
  z.object({ type: z.literal("turn.failed"), error: z.string(), code: failureCodeSchema }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
