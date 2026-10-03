/**
 * Output Styles registry.
 *
 * An "output style" is an extra block of system-prompt text that reshapes
 * HOW the agent answers (tone, structure, teaching behaviour) without
 * changing WHAT tools it has. Three styles ship built-in:
 *
 *   - default      : no extra prompt (the agent behaves as designed).
 *   - Explanatory  : the agent adds short "Insight" teaching blocks.
 *   - Learning     : the agent pauses and asks the user to write small
 *                    pieces of code (TODO(human) hand-off).
 *
 * Users can add their own under:
 *   ~/.easy-agent/output-styles/<name>.md        (user scope)
 *   <cwd>/.easy-agent/output-styles/<name>.md    (project scope, wins)
 * Enabled plugins can contribute styles from their `output-styles/` dir.
 *
 * The active style is a single piece of process-global state, flipped at
 * runtime with `/output-style <name>` and persisted to settings.json as
 * `outputStyle`. `buildSystemPrompt` reads `getActiveOutputStyleConfig()`
 * each turn so a switch takes effect on the very next request.
 *
 * There is no managed (policy) scope, and a plugin cannot force its style
 * to become active.
 */

export type OutputStyleSource = "built-in" | "user" | "project" | "plugin";

export interface OutputStyleConfig {
  /** Style identifier — what the user passes to `/output-style <name>`. */
  name: string;
  /** One-line description shown in the `/output-style` listing. */
  description: string;
  /**
   * Extra system-prompt text appended after the base prompt. Empty string
   * for the `default` style (which adds nothing).
   */
  prompt: string;
  /** Where this style came from. Project overrides user overrides built-in. */
  source: OutputStyleSource;
  /**
   * When false, the base "coding instructions" sections are dropped from the
   * system prompt so the style fully owns the agent's behaviour. Defaults to
   * true (instructions kept) — the teaching styles set it true on purpose so
   * the agent still knows how to use its tools.
   */
  keepCodingInstructions: boolean;
  /** Owning plugin id (`name@marketplace`) when source is "plugin". */
  pluginId?: string;
  /** Owning plugin root directory, for provenance / reload / unload. */
  pluginRoot?: string;
}

export const DEFAULT_OUTPUT_STYLE_NAME = "default";

// Shared between Explanatory and Learning — the "Insight" teaching block.
const INSIGHT_FEATURE_PROMPT = `## Insights
Before and after writing code, provide brief educational explanations about your implementation choices using this exact format (with backticks):
"\`✦ Insight ─────────────────────────────────────\`
[2-3 concise, specific educational points]
\`─────────────────────────────────────────────────\`"
These insights belong in the conversation, not in the codebase. Prefer insights specific to this codebase or the code you just wrote over generic programming advice.`;

const BUILT_IN_STYLES: OutputStyleConfig[] = [
  {
    name: DEFAULT_OUTPUT_STYLE_NAME,
    description: "Default — concise and professional",
    prompt: "",
    source: "built-in",
    keepCodingInstructions: true,
  },
  {
    name: "Explanatory",
    description: "Easy Agent explains its implementation choices and codebase patterns",
    keepCodingInstructions: true,
    source: "built-in",
    prompt: `You help with software engineering tasks while also providing educational insights about the codebase along the way.

Be clear and educational, providing helpful explanations while staying focused on the task. Balance teaching with task completion. When providing insights, you may exceed your usual brevity, but stay relevant.

# Explanatory Style Active
${INSIGHT_FEATURE_PROMPT}`,
  },
  {
    name: "Learning",
    description: "Easy Agent pauses and asks you to write small pieces of code for hands-on practice",
    keepCodingInstructions: true,
    source: "built-in",
    prompt: `You help with software engineering tasks while helping the user learn through hands-on practice.

Be collaborative and encouraging. Balance task completion with learning by requesting user input for meaningful design decisions while handling routine implementation yourself.

# Learning Style Active
## Requesting Human Contributions
To encourage learning, ask the human to contribute 2-10 line code pieces when generating 20+ lines involving design decisions, business logic with multiple valid approaches, or key algorithms.

- You must first add a single \`TODO(human)\` section into the codebase with your editing tools before making the request.
- Make sure there is one and only one \`TODO(human)\` section in the code.
- After the request, stop and wait for the human to implement it before proceeding.

### Request Format
\`\`\`
• Learn by Doing
Context: [what's built and why this decision matters]
Your Task: [specific function/section, mention the file and TODO(human)]
Guidance: [trade-offs and constraints to consider]
\`\`\`

${INSIGHT_FEATURE_PROMPT}`,
  },
];

// ─── In-memory state ──────────────────────────────────────────────────

const registry = new Map<string, OutputStyleConfig>();
let activeStyleName: string = DEFAULT_OUTPUT_STYLE_NAME;
let initialized = false;

function seedBuiltIns(): void {
  registry.clear();
  for (const style of BUILT_IN_STYLES) {
    registry.set(style.name, style);
  }
}

// Seed eagerly so the built-in styles are usable even before bootstrap
// runs (e.g. in unit tests that import the registry directly).
seedBuiltIns();

/**
 * Replace the custom (disk-loaded) styles, keeping the built-ins. Custom
 * styles override a built-in of the same name. Called once at startup by
 * bootstrapOutputStyles().
 */
export function setCustomOutputStyles(custom: OutputStyleConfig[]): void {
  seedBuiltIns();
  for (const style of custom) {
    registry.set(style.name, style);
  }
  initialized = true;
}

export function isOutputStylesInitialized(): boolean {
  return initialized;
}

/** Exact-name lookup; returns undefined when the style isn't registered. */
export function getOutputStyle(name: string): OutputStyleConfig | undefined {
  return registry.get(name);
}

/**
 * Resolve a user-typed name to a style, trying an exact match first and
 * then a case-insensitive fallback (so `/output-style explanatory` finds
 * `Explanatory`). Returns undefined when nothing matches.
 */
export function resolveOutputStyle(name: string): OutputStyleConfig | undefined {
  const exact = registry.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  for (const style of registry.values()) {
    if (style.name.toLowerCase() === lower) return style;
  }
  return undefined;
}

/** Every registered style (built-in + custom), built-ins first. */
export function getAllOutputStyles(): OutputStyleConfig[] {
  return [...registry.values()];
}

export function getActiveOutputStyleName(): string {
  return activeStyleName;
}

/**
 * Switch the active style. Returns false (and leaves state untouched) when
 * the name isn't registered, so callers can surface an error.
 */
export function setActiveOutputStyle(name: string): boolean {
  const resolved = resolveOutputStyle(name);
  if (!resolved) return false;
  activeStyleName = resolved.name;
  return true;
}

/**
 * Keep hot reload from leaving a dangling active style. If the selected style
 * belonged to a plugin that was disabled, removed, or failed to reload, fall
 * back to the built-in default immediately.
 *
 * Returns true when a fallback was applied so callers can surface a diagnostic.
 */
export function ensureActiveOutputStyleAvailable(): boolean {
  if (registry.has(activeStyleName)) return false;
  activeStyleName = DEFAULT_OUTPUT_STYLE_NAME;
  return true;
}

/**
 * The active style as a config — or null when the active style is `default`
 * (or has an empty prompt). buildSystemPrompt uses null to mean "add no
 * output-style section and keep the normal coding instructions".
 */
export function getActiveOutputStyleConfig(): OutputStyleConfig | null {
  const style = registry.get(activeStyleName);
  if (!style || style.prompt.trim().length === 0) return null;
  return style;
}

/** Reset everything to built-ins + default. Tests / hot reload only. */
export function clearOutputStyles(): void {
  seedBuiltIns();
  activeStyleName = DEFAULT_OUTPUT_STYLE_NAME;
  initialized = false;
}
