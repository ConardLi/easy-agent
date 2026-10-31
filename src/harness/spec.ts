/**
 * Harness specification: what one Agent is made of.
 *
 * A spec is declarative JSON. User-defined Agents live in the user settings
 * file under `harnesses.<name>`; the built-in `default` is the current
 * behavior and has no explicit values. Every field is optional, so a spec
 * only states what differs from what it extends.
 *
 * Objects are strict: a misspelled key is reported instead of silently
 * ignored.
 */

import { z } from "zod";

/** Built-in harnesses. Their values come from the defaults in `keys.ts`. */
export const BUILT_IN_HARNESSES = ["default"] as const;
export type BuiltInHarnessName = (typeof BUILT_IN_HARNESSES)[number];

/** Letters, digits, `.`, `_`, and `-`, starting with a letter or digit. */
export const HARNESS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Inline text, or a file whose content is the text. Relative paths resolve against `~/.easy-agent/`. */
export const TextSourceSchema = z.union([
  z.string(),
  z.strictObject({ text: z.string() }),
  z.strictObject({ file: z.string().trim().min(1) }),
]);
export type TextSource = z.infer<typeof TextSourceSchema>;

const Names = z.array(z.string().trim().min(1));
const Rules = z.array(z.string().trim().min(1));
const Selection = { include: Names.optional(), exclude: Names.optional() };
const ModelHandle = z.string().trim().min(1);
const PositiveInteger = z.number().int().positive();

/** Settings of one tool, by tool name. */
export const ToolConfigSchema = z.strictObject({
  /** Bash and PowerShell: timeout of a command whose call sets none. */
  timeoutMs: PositiveInteger.optional(),
  /** Bash and PowerShell: command output kept for the model. */
  maxOutputBytes: PositiveInteger.optional(),
  /** Any tool: result characters before the result is truncated. */
  maxResultChars: PositiveInteger.optional(),
});
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
/** Tools that read `timeoutMs` and `maxOutputBytes`. */
export const SHELL_TOOLS = ["Bash", "PowerShell"] as const;

const PromptSectionSchema = z.union([
  z.boolean(),
  z.strictObject({
    text: z.string().optional(),
    file: z.string().trim().min(1).optional(),
    /** Name of the section this one follows. */
    after: z.string().trim().min(1).optional(),
  }),
]);

export const HarnessSpecSchema = z.strictObject({
  extends: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  model: z
    .strictObject({
      main: ModelHandle.optional(),
      roles: z
        .strictObject({
          background: ModelHandle.optional(),
          think: ModelHandle.optional(),
          longContext: ModelHandle.optional(),
          classifier: ModelHandle.optional(),
          compaction: ModelHandle.optional(),
          webFetch: ModelHandle.optional(),
        })
        .optional(),
    })
    .optional(),
  tools: z
    .strictObject({
      ...Selection,
      config: z.record(z.string().trim().min(1), ToolConfigSchema).optional(),
      respectGitignore: z.boolean().optional(),
      webSearchBackend: z.enum(["bing", "api"]).optional(),
    })
    .optional(),
  prompt: z
    .strictObject({
      identity: TextSourceSchema.optional(),
      language: z.string().trim().min(1).optional(),
      sections: z.record(z.string().trim().min(1), PromptSectionSchema).optional(),
    })
    .optional(),
  context: z
    .strictObject({
      agentMd: z.boolean().optional(),
      memory: z.boolean().optional(),
      environment: z.boolean().optional(),
      gitStatus: z.boolean().optional(),
      skills: z.boolean().optional(),
      agents: z.boolean().optional(),
    })
    .optional(),
  compaction: z
    .strictObject({
      auto: z.boolean().optional(),
      /** Fraction of the effective context window at which auto-compaction starts. */
      autoThreshold: z.number().gt(0).max(1).optional(),
      microcompact: z.boolean().optional(),
      keepRecentMessages: z.number().int().positive().optional(),
      contextWindow: z.number().int().positive().optional(),
    })
    .optional(),
  permissions: z
    .strictObject({
      mode: z.enum(["default", "plan", "auto"]).optional(),
      allow: Rules.optional(),
      deny: Rules.optional(),
      ask: Rules.optional(),
    })
    .optional(),
  sandbox: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  hooks: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  skills: z.strictObject({ ...Selection, listingBudgetChars: z.number().int().positive().optional() }).optional(),
  agents: z.strictObject(Selection).optional(),
  commands: z.strictObject(Selection).optional(),
  outputStyle: z.string().trim().min(1).optional(),
  mcpServers: z.strictObject(Selection).optional(),
  plugins: z.strictObject(Selection).optional(),
  features: z
    .strictObject({
      agentTeams: z.boolean().optional(),
      toolSearch: z.enum(["off", "auto", "on"]).optional(),
      toolSearchAutoThreshold: z.number().min(0).max(100).optional(),
      thinking: z.boolean().optional(),
      thinkingBudget: z.number().int().positive().optional(),
      thinkingInRequests: z.boolean().optional(),
      adaptiveThinking: z.boolean().optional(),
      interleavedThinking: z.boolean().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
      effortForAllModels: z.boolean().optional(),
      promptCaching: z.boolean().optional(),
      experimentalBetas: z.boolean().optional(),
      maxRetries: z.number().int().nonnegative().optional(),
      maxTurns: z.number().int().positive().optional(),
    })
    .optional(),
  session: z.strictObject({ checkpoints: z.boolean().optional() }).optional(),
  trace: z.strictObject({ level: z.enum(["off", "summary", "full"]).optional() }).optional(),
});

export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;

/** Top-level spec keys, one per component kind (plus `extends` and `description`). */
export type HarnessComponent = Exclude<keyof HarnessSpec, "extends" | "description">;
