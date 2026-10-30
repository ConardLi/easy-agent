/**
 * Keeps the configuration inventory complete.
 *
 * Every switch that changes how Easy Agent behaves is listed in one place:
 * settings keys and environment variables in `src/config/catalog.ts`, and
 * `process.argv` checks outside the CLI parser, dynamic environment reads,
 * and behavior constants in this file. The check parses `src/` (without
 * `src/scripts/`) and fails when code reads something the inventory does not
 * list, when an inventory entry no longer matches the code, or when
 * `docs/configuration-inventory.md` is out of date.
 *
 * Run: node --import tsx scripts/check-config-inventory.ts [--write]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ENVIRONMENT_VARIABLES,
  SETTING_CATALOG,
  SETTING_DEFAULTS,
  SETTING_RELOAD,
  type SettingScope,
} from "../src/config/catalog.js";
import { SettingsSchema } from "../src/config/schema.js";
import { HARNESS_KEYS } from "../src/harness/keys.js";

interface ArgvCheck {
  flag: string;
  file: string;
  summary: string;
}

interface DynamicEnvRead {
  file: string;
  reason: string;
}

interface BehaviorConstant {
  component: string;
  file: string;
  /** Exact source text; the check fails when the file no longer contains it. */
  declaration: string;
  summary: string;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = "src";
const EXCLUDED_DIRECTORY = "src/scripts";
const DOC_FILE = "docs/configuration-inventory.md";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** The CLI parser reads its flags from `process.argv`; `eagent --help` lists them. */
const ARGV_PARSER_DIRECTORY = "src/entrypoint";

/** `process.argv` checks outside the CLI parser. */
const ARGV_CHECKS: ArgvCheck[] = [
  {
    flag: "--agent-teams",
    file: "src/utils/agentTeamsEnabled.ts",
    summary: "Turns on Agent Teams for the process, like EASY_AGENT_TEAMS.",
  },
  {
    flag: "--agent-teams",
    file: "src/harness/resolve.ts",
    summary: "The Harness resolver records it as the flag-layer value of features.agentTeams.",
  },
];

/** Reads whose variable name comes from configuration or from a listed name. */
const DYNAMIC_ENV_READS: DynamicEnvRead[] = [
  {
    file: "src/services/api/providers/profile.ts",
    reason: "`${VAR}` references in model profile fields.",
  },
  {
    file: "src/services/mcp/remoteHeaders.ts",
    reason: "`headersEnv` of a remote MCP server names the variables to send as headers.",
  },
  {
    file: "src/services/mcp/oauth.ts",
    reason: "`clientSecretEnv` of an MCP OAuth config names the variable holding the client secret.",
  },
  {
    file: "src/utils/loadEnv.ts",
    reason: "Writes `env` settings and the workspace `.env` into the process environment.",
  },
  {
    file: "src/config/features.ts",
    reason: "Picks EASY_AGENT_ENABLE_TOOL_SEARCH or ENABLE_TOOL_SEARCH, both listed.",
  },
  {
    file: "src/harness/resolve.ts",
    reason: "Notices a change in any variable a Harness key reads, all listed.",
  },
];

/** The resolver reads the environment; everything else reads the resolved harness. */
const HARNESS_DIRECTORY = "src/harness";

/**
 * Files that still read an environment variable a Harness key resolves,
 * instead of the Agent's value from the resolved harness. Entries go away as
 * code moves to the harness; a new direct read fails the check.
 */
const DIRECT_HARNESS_ENV_READS: { file: string; names: string[] }[] = [
  { file: "src/config/features.ts", names: ["EASY_AGENT_ENABLE_TOOL_SEARCH"] },
  { file: "src/context/compaction.ts", names: ["ANTHROPIC_MODEL"] },
  { file: "src/core/queryEngine/commands/diagnostics.ts", names: ["ANTHROPIC_MODEL"] },
  { file: "src/entrypoint/login.ts", names: ["ANTHROPIC_MODEL"] },
  { file: "src/permissions/autoClassifier.ts", names: ["ANTHROPIC_MODEL"] },
  { file: "src/services/api/client.ts", names: ["ANTHROPIC_MODEL"] },
  { file: "src/services/skills/budget.ts", names: ["EASY_AGENT_SKILL_CHAR_BUDGET"] },
  { file: "src/session/fileHistory.ts", names: ["EASY_AGENT_DISABLE_CHECKPOINTING"] },
  { file: "src/tools/webSearch/adapters.ts", names: ["WEB_SEARCH_ADAPTER"] },
  { file: "src/utils/agentTeamsEnabled.ts", names: ["EASY_AGENT_TEAMS"] },
  {
    file: "src/utils/tokens.ts",
    names: ["EASY_AGENT_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "ANTHROPIC_MODEL"],
  },
  { file: "src/utils/toolSearch.ts", names: ["EASY_AGENT_ENABLE_TOOL_SEARCH", "ENABLE_TOOL_SEARCH"] },
];

const BEHAVIOR_CONSTANTS: BehaviorConstant[] = [
  {
    component: "model",
    file: "src/services/api/client.ts",
    declaration: 'const FALLBACK_MODEL = "claude-sonnet-4-20250514";',
    summary: "Model when no setting, flag, or ANTHROPIC_MODEL selects one.",
  },
  {
    component: "model",
    file: "src/permissions/autoClassifier.ts",
    declaration: '?? "claude-3-5-haiku-latest"',
    summary: "Auto Mode classifier model when EASY_AGENT_AUTO_MODE_MODEL and ANTHROPIC_MODEL are unset.",
  },
  {
    component: "model",
    file: "src/services/api/client.ts",
    declaration: "export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;",
    summary: "Default max output tokens per request.",
  },
  {
    component: "model",
    file: "src/services/api/client.ts",
    declaration: "export const ESCALATED_MAX_TOKENS = 64_000;",
    summary: "Max output tokens after a response is cut off at the default limit.",
  },
  {
    component: "model",
    file: "src/harness/keys.ts",
    declaration: "export const DEFAULT_MAX_RETRIES = 10;",
    summary: "Retries for a failed model request (EASY_AGENT_MAX_RETRIES).",
  },
  {
    component: "loop",
    file: "src/core/agenticLoop.ts",
    declaration: "export const MAX_TOOL_TURNS = 50;",
    summary:
      "Tool-turn limit per request when --max-turns, the maxTurns setting, and the SDK defaultMaxTurns are unset; Headless runs use it.",
  },
  {
    component: "loop",
    file: "src/core/agenticLoop.ts",
    declaration: "export const INTERACTIVE_MAX_TOOL_TURNS = 200;",
    summary: "Tool-turn limit per request in the terminal UI, RPC, and ACP.",
  },
  {
    component: "loop",
    file: "src/core/agenticLoop.ts",
    declaration: "const MAX_TOOL_USE_CONCURRENCY = 10;",
    summary: "Concurrency-safe tool calls run at the same time.",
  },
  {
    component: "compaction",
    file: "src/utils/tokens.ts",
    declaration: "export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;",
    summary: "Context window of a model with no known size.",
  },
  {
    component: "compaction",
    file: "src/utils/tokens.ts",
    declaration: "export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;",
    summary: "Tokens kept free for the compaction summary, at most 20% of the window.",
  },
  {
    component: "compaction",
    file: "src/utils/tokens.ts",
    declaration: "export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;",
    summary: "Auto-compaction starts this far below the effective window.",
  },
  {
    component: "compaction",
    file: "src/utils/tokens.ts",
    declaration: "export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;",
    summary: "The context warning starts this far below the effective window.",
  },
  {
    component: "compaction",
    file: "src/context/compaction.ts",
    declaration: "const MICROCOMPACT_MIN_MESSAGES = 10;",
    summary: "Messages before old tool results are cleared.",
  },
  {
    component: "compaction",
    file: "src/context/compaction.ts",
    declaration: "const MICROCOMPACT_KEEP_RECENT_MESSAGES = 8;",
    summary: "Recent messages whose tool results are kept when clearing.",
  },
  {
    component: "tools",
    file: "src/tools/bashTool.ts",
    declaration: "const DEFAULT_TIMEOUT_MS = 120_000;",
    summary: "Bash command timeout when the call sets none.",
  },
  {
    component: "tools",
    file: "src/tools/bashTool.ts",
    declaration: "const MAX_OUTPUT_BYTES = 30_000;",
    summary: "Bash output kept for the model.",
  },
  {
    component: "tools",
    file: "src/tools/Tool.ts",
    declaration: "export const DEFAULT_MAX_RESULT_SIZE_CHARS = 100_000;",
    summary: "Tool result size before it is truncated, unless the tool sets its own.",
  },
  {
    component: "context",
    file: "src/context/memory/memdir.ts",
    declaration: "export const MAX_ENTRYPOINT_LINES = 200;",
    summary: "Lines of MEMORY.md loaded into the system prompt.",
  },
  {
    component: "context",
    file: "src/context/memory/memdir.ts",
    declaration: "export const MAX_ENTRYPOINT_BYTES = 25_000;",
    summary: "Bytes of MEMORY.md loaded into the system prompt.",
  },
  {
    component: "context",
    file: "src/context/planAttachments.ts",
    declaration: "const TURNS_BETWEEN_ATTACHMENTS = 5;",
    summary: "Turns between Plan Mode reminders.",
  },
  {
    component: "skills",
    file: "src/services/skills/budget.ts",
    declaration: "const DEFAULT_BUDGET_CHARS = 8000;",
    summary: "Characters for the skill listing (EASY_AGENT_SKILL_CHAR_BUDGET).",
  },
  {
    component: "permissions",
    file: "src/permissions/autoModeState.ts",
    declaration: "export const CLASSIFIER_FAILURE_LIMIT = 3;",
    summary: "Consecutive classifier failures after which Auto Mode stops calling the classifier in the session.",
  },
  {
    component: "hooks",
    file: "src/hooks/settings.ts",
    declaration: "const DEFAULT_HOOK_TIMEOUT_SEC = 60;",
    summary: "Hook command timeout when the hook sets none.",
  },
  {
    component: "mcp",
    file: "src/services/mcp/client.ts",
    declaration: "const CONNECT_TIMEOUT_MS = 30_000;",
    summary: "MCP connection timeout (MCP_CONNECT_TIMEOUT).",
  },
  {
    component: "session",
    file: "src/session/storage.ts",
    declaration: "export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;",
    summary: "Days to keep transcripts when cleanupPeriodDays is unset.",
  },
  {
    component: "session",
    file: "src/session/fileHistory.ts",
    declaration: "const MAX_SNAPSHOTS = 100;",
    summary: "File checkpoints kept per session.",
  },
];

// ─── Scanning ────────────────────────────────────────────────────────────

interface EnvRead {
  name: string;
  file: string;
  line: number;
}

interface Located {
  file: string;
  line: number;
}

interface ScanResult {
  envReads: EnvRead[];
  dynamicEnvReads: Located[];
  argvReads: (Located & { flags: string[] })[];
  settingKeys: (Located & { key: string })[];
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SETTING_READERS = /^(?:read(?:Merged|Trusted)\w*Setting|getScalarSetting)$/;

function isProcessMember(node: ts.Expression, member: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === member
  );
}

/** `process.env`, or an identifier named `env` (a parameter defaulting to `process.env`, or a copy of it). */
function isEnvObject(node: ts.Expression): boolean {
  return isProcessMember(node, "env") || (ts.isIdentifier(node) && node.text === "env");
}

/**
 * `<source>.raw`, the parsed object of one settings layer. A bare `raw` is
 * usually tool input, and `split.raw` is Markdown frontmatter.
 */
function isSettingsRaw(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "raw" &&
    !(ts.isIdentifier(node.expression) && node.expression.text === "split")
  );
}

function enclosingStatement(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent) && !ts.isBlock(current.parent)) current = current.parent;
  return current;
}

function flagLiterals(node: ts.Node): string[] {
  const flags: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteralLike(child) && /^--?[a-z]/.test(child.text)) flags.push(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return flags;
}

export function scanSource(file: string, text: string): ScanResult {
  const result: ScanResult = { envReads: [], dynamicEnvReads: [], argvReads: [], settingKeys: [] };
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression) && ENV_NAME.test(node.name.text)) {
      result.envReads.push({ name: node.name.text, file, line: lineOf(node) });
    } else if (ts.isElementAccessExpression(node) && isEnvObject(node.expression)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        if (ENV_NAME.test(arg.text)) result.envReads.push({ name: arg.text, file, line: lineOf(node) });
      } else result.dynamicEnvReads.push({ file, line: lineOf(node) });
    } else if (ts.isElementAccessExpression(node) && isSettingsRaw(node.expression)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) result.settingKeys.push({ key: arg.text, file, line: lineOf(node) });
    } else if (isProcessMember(node as ts.Expression, "argv")) {
      result.argvReads.push({ file, line: lineOf(node), flags: flagLiterals(enclosingStatement(node)) });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const key = node.arguments[1];
      if (SETTING_READERS.test(name) && key && ts.isStringLiteralLike(key)) {
        result.settingKeys.push({ key: key.text, file, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(PROJECT_ROOT, dir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (relative !== EXCLUDED_DIRECTORY) files.push(...(await listSourceFiles(relative)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      files.push(relative);
    }
  }
  return files.sort();
}

async function scanTree(): Promise<{ scan: ScanResult; texts: Map<string, string> }> {
  const scan: ScanResult = { envReads: [], dynamicEnvReads: [], argvReads: [], settingKeys: [] };
  const texts = new Map<string, string>();
  for (const file of await listSourceFiles(SCAN_ROOT)) {
    const text = await readFile(path.join(PROJECT_ROOT, file), "utf8");
    texts.set(file, text);
    const result = scanSource(file, text);
    scan.envReads.push(...result.envReads);
    scan.dynamicEnvReads.push(...result.dynamicEnvReads);
    scan.argvReads.push(...result.argvReads);
    scan.settingKeys.push(...result.settingKeys);
  }
  return { scan, texts };
}

// ─── Checks ──────────────────────────────────────────────────────────────

function listedEnvironmentNames(): Set<string> {
  return new Set(ENVIRONMENT_VARIABLES.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]));
}

function supportedSettingKeys(): Set<string> {
  return new Set([...Object.keys(SettingsSchema.shape), "sandbox"]);
}

/** Variable name → the Harness keys it sets. */
function harnessKeysByVariable(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const key of HARNESS_KEYS)
    for (const name of key.env?.names ?? []) byName.set(name, [...(byName.get(name) ?? []), key.path]);
  return byName;
}

/** Reads of a Harness-resolved variable outside the resolver. */
function directHarnessEnvReads(scan: ScanResult): EnvRead[] {
  const resolved = harnessKeysByVariable();
  return scan.envReads.filter((read) => resolved.has(read.name) && !read.file.startsWith(`${HARNESS_DIRECTORY}/`));
}

export function findProblems(scan: ScanResult, texts: ReadonlyMap<string, string>, complete: boolean): string[] {
  const problems: string[] = [];
  const listedEnv = listedEnvironmentNames();
  const catalogKeys = new Set(Object.keys(SETTING_CATALOG));
  const loc = (item: Located) => `${item.file}:${item.line}`;

  for (const read of scan.envReads) {
    if (!listedEnv.has(read.name)) {
      problems.push(
        `${loc(read)} reads ${read.name}, which ENVIRONMENT_VARIABLES in src/config/catalog.ts does not list`,
      );
    }
  }
  for (const read of scan.dynamicEnvReads) {
    if (!DYNAMIC_ENV_READS.some((entry) => entry.file === read.file)) {
      problems.push(`${loc(read)} reads an environment variable by a computed name; list it in DYNAMIC_ENV_READS`);
    }
  }
  for (const read of scan.argvReads) {
    if (read.file.startsWith(`${ARGV_PARSER_DIRECTORY}/`)) continue;
    const unlisted = read.flags.filter(
      (flag) => !ARGV_CHECKS.some((entry) => entry.file === read.file && entry.flag === flag),
    );
    if (read.flags.length === 0) problems.push(`${loc(read)} reads process.argv outside the CLI parser`);
    for (const flag of unlisted) problems.push(`${loc(read)} checks ${flag} in process.argv; list it in ARGV_CHECKS`);
  }
  for (const use of scan.settingKeys) {
    if (!catalogKeys.has(use.key)) {
      problems.push(`${loc(use)} reads setting "${use.key}", which SETTING_CATALOG does not list`);
    }
  }
  const harnessKeys = harnessKeysByVariable();
  const directReads = directHarnessEnvReads(scan);
  for (const read of directReads) {
    if (!DIRECT_HARNESS_ENV_READS.some((entry) => entry.file === read.file && entry.names.includes(read.name))) {
      problems.push(
        `${loc(read)} reads ${read.name} directly; read ${harnessKeys.get(read.name)!.join(" or ")} with harnessSetting() instead`,
      );
    }
  }

  if (!complete) return problems;

  for (const entry of DIRECT_HARNESS_ENV_READS) {
    for (const name of entry.names) {
      if (!directReads.some((read) => read.file === entry.file && read.name === name))
        problems.push(`DIRECT_HARNESS_ENV_READS lists ${name} in ${entry.file}, which no longer reads it; remove it`);
    }
  }

  const supported = supportedSettingKeys();
  for (const key of supported) {
    if (!catalogKeys.has(key))
      problems.push(`setting "${key}" is supported by SettingsSchema but missing from SETTING_CATALOG`);
  }
  for (const key of catalogKeys) {
    if (!supported.has(key)) problems.push(`SETTING_CATALOG lists "${key}", which SettingsSchema does not support`);
  }
  for (const key of [...Object.keys(SETTING_RELOAD), ...Object.keys(SETTING_DEFAULTS)]) {
    if (!catalogKeys.has(key))
      problems.push(`SETTING_RELOAD or SETTING_DEFAULTS has "${key}", which SETTING_CATALOG does not list`);
  }

  const readNames = new Set(scan.envReads.map((read) => read.name));
  for (const name of listedEnv) {
    if (!readNames.has(name)) problems.push(`ENVIRONMENT_VARIABLES lists ${name}, which no code under src/ reads`);
  }
  const dynamicFiles = new Set(scan.dynamicEnvReads.map((read) => read.file));
  for (const entry of DYNAMIC_ENV_READS) {
    if (!dynamicFiles.has(entry.file))
      problems.push(`DYNAMIC_ENV_READS lists ${entry.file}, which no longer reads by a computed name`);
  }
  for (const entry of ARGV_CHECKS) {
    if (!scan.argvReads.some((read) => read.file === entry.file && read.flags.includes(entry.flag))) {
      problems.push(`ARGV_CHECKS lists ${entry.flag} in ${entry.file}, which no longer checks it`);
    }
  }
  for (const constant of BEHAVIOR_CONSTANTS) {
    if (!texts.get(constant.file)?.includes(constant.declaration)) {
      problems.push(`BEHAVIOR_CONSTANTS expects \`${constant.declaration}\` in ${constant.file}; update the entry`);
    }
  }
  return problems;
}

/** The detector must flag each kind of unlisted read; otherwise the check passes vacuously. */
function selfTest(): void {
  const sample = [
    "const a = process.env.UNLISTED_SAMPLE_VARIABLE;",
    'const b = process.env["ANOTHER_UNLISTED_SAMPLE"];',
    "function f(env = process.env) { return env.THIRD_UNLISTED_SAMPLE; }",
    "const c = process.env[name];",
    'const d = process.argv.includes("--sample-flag");',
    'const e = await readMergedStringSetting(cwd, "sampleUnlistedKey");',
    'const g = source.raw?.["anotherUnlistedKey"];',
    "// process.env.IN_A_COMMENT is not a read",
    "const h = process.env.ANTHROPIC_BASE_URL;",
    "const i = process.env.EASY_AGENT_MAX_RETRIES;",
  ].join("\n");
  const problems = findProblems(scanSource("src/sample.ts", sample), new Map(), false);
  const expected = [
    "UNLISTED_SAMPLE_VARIABLE",
    "ANOTHER_UNLISTED_SAMPLE",
    "THIRD_UNLISTED_SAMPLE",
    "computed name",
    "--sample-flag",
    '"sampleUnlistedKey"',
    '"anotherUnlistedKey"',
    "reads EASY_AGENT_MAX_RETRIES directly; read features.maxRetries",
  ];
  const missing = expected.filter((fragment) => !problems.some((problem) => problem.includes(fragment)));
  const unexpected = problems.filter((problem) => /IN_A_COMMENT|ANTHROPIC_BASE_URL/.test(problem));
  const resolverRead = findProblems(
    scanSource(`${HARNESS_DIRECTORY}/sample.ts`, "const r = env.EASY_AGENT_MAX_RETRIES;"),
    new Map(),
    false,
  );
  if (resolverRead.length) unexpected.push(...resolverRead);
  if (missing.length || unexpected.length || problems.length !== expected.length) {
    throw new Error(
      `config inventory self-test failed\n  missing: ${missing.join(", ") || "-"}\n  problems:\n${problems.map((p) => `    ${p}`).join("\n")}`,
    );
  }
}

// ─── Document ────────────────────────────────────────────────────────────

const SCOPE_LABEL: Record<SettingScope, string> = {
  trusted: "all; project and local need trust",
  any: "all, also untrusted",
  user: "user, flag, policy",
  "user-file": "user file only",
};

const cell = (value: string) => value.replace(/\|/g, "\\|");
const code = (value: string) => `\`${value}\``;

function readersOf(scan: ScanResult, names: readonly string[]): string {
  const files = [...new Set(scan.envReads.filter((read) => names.includes(read.name)).map((read) => read.file))].sort();
  return files.map(code).join(", ");
}

export function renderDocument(scan: ScanResult): string {
  const lines: string[] = [
    "# Configuration inventory",
    "",
    "<!-- Generated by `npm run config:inventory`; `npm run check:config-inventory` fails when it is out of date. -->",
    "",
    "Every switch that changes how Easy Agent behaves: settings keys, environment variables, `process.argv` checks outside the CLI parser, and behavior constants. Each settings key and environment variable belongs to one category:",
    "",
    "- **environment**: facts about the machine, the project, or the terminal UI, such as provider endpoints and credentials, trust, sandbox, retention, and display.",
    "- **resource**: what is installed and approved: MCP servers, hooks, plugins, rule files.",
    "- **agent**: how the agent is composed and behaves: model, tools, prompt, permissions, compaction, feature switches.",
    "",
    "**Security** marks entries that change what the agent may execute, read, write, or reach, or which credentials it uses. See [configuration.md](./configuration.md) for how the layers combine and [configuration-security.md](./configuration-security.md) for the trust rules.",
    "",
    "## Settings keys",
    "",
    "Layers are user (`~/.easy-agent/settings.json`), project (`.easy-agent/settings.json`), local (`.easy-agent/settings.local.json`), flag (CLI flags and `--settings`), and policy (managed settings).",
    "",
    "| Key | Category | Security | Read from layers | Takes effect | Default | Summary |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [key, entry] of Object.entries(SETTING_CATALOG).sort(([a], [b]) => a.localeCompare(b))) {
    const fallback = SETTING_DEFAULTS[key];
    const summary = entry.scopeNote ? `${entry.summary} ${entry.scopeNote}` : entry.summary;
    lines.push(
      `| ${code(key)} | ${entry.category} | ${entry.security ? "yes" : ""} | ${SCOPE_LABEL[entry.scope]} | ${SETTING_RELOAD[key] ?? "restart"} | ${fallback === undefined ? "" : code(JSON.stringify(fallback))} | ${cell(summary)} |`,
    );
  }

  lines.push(
    "",
    "## Environment variables",
    "",
    "`use` means the value is read each time the code path runs; `session` means it is read when a session starts; `runtime` means it is resolved into the Agent's settings when the runtime starts (`eagent harness show` lists the result). `env` settings and the workspace `.env` are written into the process environment when the workspace starts, so changing them takes a restart. Category `system` marks variables set by the operating system or the shell.",
    "",
    "| Variable | Category | Security | Read | Default | Settings or flag | Summary | Read in |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const entry of [...ENVIRONMENT_VARIABLES].sort((a, b) => a.name.localeCompare(b.name))) {
    const names = [entry.name, ...(entry.aliases ?? [])];
    lines.push(
      `| ${names.map(code).join(", ")} | ${entry.category} | ${entry.security ? "yes" : ""} | ${entry.readAt} | ${cell(entry.default ?? "")} | ${entry.replacement ? entry.replacement.split(", ").map(code).join(", ") : ""} | ${cell(entry.summary)} | ${readersOf(scan, names)} |`,
    );
  }
  lines.push(
    "",
    "Variables named by configuration are read too:",
    "",
    ...DYNAMIC_ENV_READS.map((entry) => `- ${code(entry.file)}: ${entry.reason}`),
    "",
    "## `process.argv` checks outside the CLI parser",
    "",
    "The CLI parser in `src/entrypoint/` reads the flags that `eagent --help` lists. These checks read `process.argv` elsewhere:",
    "",
    "| Flag | File | Summary |",
    "|---|---|---|",
    ...ARGV_CHECKS.map((entry) => `| ${code(entry.flag)} | ${code(entry.file)} | ${cell(entry.summary)} |`),
    "",
    "## Behavior constants",
    "",
    "Fixed values that change behavior and have no setting yet.",
    "",
    "| Component | Declaration | File | Summary |",
    "|---|---|---|---|",
    ...BEHAVIOR_CONSTANTS.map(
      (entry) =>
        `| ${entry.component} | ${code(cell(entry.declaration))} | ${code(entry.file)} | ${cell(entry.summary)} |`,
    ),
    "",
  );
  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.length === 1 && args[0] === "--write";
  if (args.length > 0 && !write) throw new Error("Usage: check-config-inventory.ts [--write]");

  selfTest();
  const { scan, texts } = await scanTree();
  const problems = findProblems(scan, texts, true);
  if (problems.length) {
    process.stdout.write(`Configuration inventory is out of date (${problems.length}):\n`);
    for (const problem of problems) process.stdout.write(`  ${problem}\n`);
    process.exitCode = 1;
    return;
  }

  const document = renderDocument(scan);
  const docPath = path.join(PROJECT_ROOT, DOC_FILE);
  if (write) {
    await writeFile(docPath, document);
    process.stdout.write(`Wrote ${DOC_FILE}\n`);
    return;
  }
  const current = await readFile(docPath, "utf8").catch(() => "");
  if (current !== document) {
    process.stdout.write(`${DOC_FILE} is out of date; run npm run config:inventory\n`);
    process.exitCode = 1;
    return;
  }
  const directReads = directHarnessEnvReads(scan);
  process.stdout.write(
    `Configuration inventory: ${Object.keys(SETTING_CATALOG).length} settings, ${ENVIRONMENT_VARIABLES.length} environment variables, ${ARGV_CHECKS.length} argv checks, ${BEHAVIOR_CONSTANTS.length} constants. ` +
      `Agent variables still read outside the resolver: ${directReads.length} reads in ${new Set(directReads.map((read) => read.file)).size} files.\n`,
  );
}

await main();
