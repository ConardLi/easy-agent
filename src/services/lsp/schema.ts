import { z } from "zod";

export const LspServerSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  extensionToLanguage: z.record(z.string().regex(/^\.[\w+-]+$/), z.string().min(1)),
  transport: z.literal("stdio").default("stdio"),
  env: z.record(z.string(), z.string()).optional(),
  initializationOptions: z.unknown().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  startupTimeout: z.number().int().min(1).max(120000).default(10000),
  requestTimeout: z.number().int().min(1).max(120000).default(10000),
  restartOnCrash: z.boolean().default(true),
  maxRestarts: z.number().int().min(0).max(5).default(2),
}).strict();
export const LspServersSchema = z.record(z.string().regex(/^[\w-]+$/), LspServerSchema);
export type LspServerConfig = z.infer<typeof LspServerSchema>;
