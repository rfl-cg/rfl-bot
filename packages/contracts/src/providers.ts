import { z } from "zod";

/**
 * Provedores de IA (direção: tabela de provedores do OpenBot).
 * Cada um roda pelo CLI oficial, logado com a assinatura do dono.
 */
export const PROVIDER_IDS = ["claude", "echo"] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

export type SignInKind =
  /** Abre o link, faz login e manda de volta o código que a página mostra. */
  | "paste-code"
  /** Não precisa de login. */
  | "none";

export type ProviderDescriptor = {
  displayName: string;
  signIn: SignInKind;
  /** Assinatura que dá acesso. */
  plans: string;
  defaultModel: string;
  /** Só para testes; não aparece para o dono. */
  internal?: boolean;
};

export const PROVIDERS = {
  claude: {
    displayName: "Claude",
    signIn: "paste-code",
    plans: "Claude Pro ou Max",
    defaultModel: "claude-opus-5-5",
  },
  echo: {
    displayName: "Eco (teste)",
    signIn: "none",
    plans: "nenhuma",
    defaultModel: "eco",
    internal: true,
  },
} as const satisfies Record<ProviderId, ProviderDescriptor>;

export const accountSchema = z.object({
  email: z.string().nullable(),
  plan: z.string().nullable(),
});

export const providerStatusSchema = z.object({
  id: providerIdSchema,
  displayName: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  signedIn: z.boolean(),
  account: accountSchema.nullable(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const loginStartResponseSchema = z.object({
  loginId: z.string(),
  url: z.url({ protocol: /^https$/ }),
  needsCode: z.boolean(),
});
export type LoginStartResponse = z.infer<typeof loginStartResponseSchema>;

export const loginCodeRequestSchema = z.object({
  code: z.string().trim().min(4).max(1000),
});

export const loginCodeResponseSchema = z.object({
  signedIn: z.boolean(),
  account: accountSchema.nullable(),
  error: z.string().optional(),
});
export type LoginCodeResponse = z.infer<typeof loginCodeResponseSchema>;
