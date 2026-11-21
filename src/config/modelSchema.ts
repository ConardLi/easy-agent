import { z } from "zod";

/** The connection contract shared by settings, RPC, SDK, and configuration editors. */
export const MODEL_PROTOCOLS = ["anthropic", "openai-chat", "openai-responses", "gemini"] as const;
export const ModelProtocolSchema = z.enum(MODEL_PROTOCOLS);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;
export const ENVIRONMENT_PROFILE_ID = "@environment";

const PositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonEmptyString = z.string().trim().min(1);

export const ReasoningSchema = z.strictObject({
  mode: z.enum(["auto", "on", "off"]).optional(),
  budgetTokens: PositiveInteger.optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
});
export type ReasoningSettings = z.infer<typeof ReasoningSchema>;

/**
 * A key has exactly one source. Strings may contain explicit environment
 * references. Helpers are bound to the profile that declares them.
 */
export const ApiKeySourceSchema = z.union([NonEmptyString, z.strictObject({ helper: NonEmptyString })]);
export type ApiKeySource = z.infer<typeof ApiKeySourceSchema>;

export const AuthenticationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("default") }),
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("header"),
    name: z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
    /** Literal prefix, for example "Bearer ". It never contains another credential. */
    prefix: z
      .string()
      .regex(/^[^\r\n]*$/)
      .optional(),
  }),
]);
export type Authentication = z.infer<typeof AuthenticationSchema>;

export const ModelCapabilitiesSchema = z.strictObject({
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  cache: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  adaptiveReasoning: z.boolean().optional(),
  interleavedReasoning: z.boolean().optional(),
  effort: z.boolean().optional(),
  contextWindow: PositiveInteger.optional(),
  maxOutputTokens: PositiveInteger.optional(),
  /** USD per million tokens. Omitted prices are unknown, never zero. */
  pricing: z
    .strictObject({
      input: z.number().finite().nonnegative(),
      output: z.number().finite().nonnegative(),
      cacheRead: z.number().finite().nonnegative().optional(),
      cacheWrite: z.number().finite().nonnegative().optional(),
    })
    .optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ProtocolOptionsSchema = z.strictObject({
  anthropic: z
    .strictObject({
      adaptiveThinking: z.boolean().optional(),
      interleavedThinking: z.boolean().optional(),
      countTokens: z.boolean().optional(),
    })
    .optional(),
  "openai-chat": z
    .strictObject({ promptCacheKey: z.boolean().optional(), reasoningOff: z.literal("none").optional() })
    .optional(),
  "openai-responses": z
    .strictObject({ promptCacheKey: z.boolean().optional(), reasoningOff: z.literal("none").optional() })
    .optional(),
  gemini: z.strictObject({ reasoningOff: z.literal("budget-zero").optional() }).optional(),
});
export type ProtocolOptions = z.infer<typeof ProtocolOptionsSchema>;

export const AUTHENTICATION_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

export function isAuthenticationHeader(name: string): boolean {
  return (
    AUTHENTICATION_HEADER_NAMES.has(name.toLowerCase()) ||
    /(?:^|[-_])(?:api[-_]?key|auth[-_]?token|access[-_]?token|secret)(?:$|[-_])/i.test(name)
  );
}

export const ModelProfileSchema = z
  .strictObject({
    protocol: ModelProtocolSchema,
    model: NonEmptyString,
    baseURL: NonEmptyString.optional(),
    apiKey: ApiKeySourceSchema.optional(),
    authentication: AuthenticationSchema.optional(),
    maxTokens: PositiveInteger.optional(),
    headers: z.record(NonEmptyString, z.string()).optional(),
    capabilities: ModelCapabilitiesSchema.optional(),
    protocolOptions: ProtocolOptionsSchema.optional(),
  })
  .superRefine((profile, ctx) => {
    if (
      profile.protocol !== "anthropic" &&
      (profile.capabilities?.adaptiveReasoning === true || profile.capabilities?.interleavedReasoning === true)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Adaptive and interleaved reasoning declarations apply only to the Anthropic protocol.",
      });
    }
    for (const protocol of Object.keys(profile.protocolOptions ?? {})) {
      if (protocol !== profile.protocol) {
        ctx.addIssue({
          code: "custom",
          path: ["protocolOptions", protocol],
          message: "Protocol options must belong to the selected protocol.",
        });
      }
    }
    for (const [name, value] of Object.entries(profile.headers ?? {})) {
      if (
        isAuthenticationHeader(name) ||
        (profile.authentication?.type === "header" && name.toLowerCase() === profile.authentication.name.toLowerCase())
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["headers"],
          message: "Authentication headers belong in authentication and must use the profile's single API Key.",
        });
      } else if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n]/.test(value)) {
        ctx.addIssue({ code: "custom", path: ["headers"], message: "Invalid HTTP header." });
      }
    }
    if (profile.authentication?.type === "none" && profile.apiKey !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "Remove apiKey when explicitly selecting no authentication.",
      });
    }
    const context = profile.capabilities?.contextWindow;
    const output = profile.maxTokens ?? profile.capabilities?.maxOutputTokens;
    if (output !== undefined && context !== undefined && output >= context) {
      ctx.addIssue({
        code: "custom",
        path: ["maxTokens"],
        message: "Output tokens must leave room for input in the context window.",
      });
    }
    if (
      profile.maxTokens !== undefined &&
      profile.capabilities?.maxOutputTokens !== undefined &&
      profile.maxTokens > profile.capabilities.maxOutputTokens
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxTokens"],
        message: "Output tokens exceed the model's declared output limit.",
      });
    }
  });
export type ModelProfileConfig = z.infer<typeof ModelProfileSchema>;

/** Errors contain field names and remedies, never rejected values or helper output. */
export function profileValidationErrors(value: unknown, location: string): string[] {
  const parsed = ModelProfileSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const field = issue.path.slice(0, 3).map(String).join(".");
    // Zod enum and union diagnostics can include user-supplied values.
    return `${location}${field ? `.${field}` : ""}: ${
      issue.code === "custom" ? issue.message : "invalid configuration; check the model profile contract."
    }`;
  });
}
