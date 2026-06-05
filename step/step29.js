/**
 * Step 29 - Auto Mode classifier
 *
 * Goal:
 * - keep normal allow/deny rules first
 * - when a tool would ask, run an AI-style classifier for a second decision
 * - fast-path obviously safe/dangerous Bash commands
 * - degrade to ask/deny instead of silently allowing unsafe actions
 */

// -----------------------------------------------------------------------------
// 1. Rule matching and dangerous allow filtering
// -----------------------------------------------------------------------------

const COORDINATION_TOOLS = new Set(["TodoWrite", "TaskList", "TaskCreate", "TaskUpdate", "SendMessage"]);
const CLASSIFIER_FORBIDDEN_TOOLS = new Set(["EnterPlanMode"]);

export function matchesPermissionRule(rule, toolName, input = {}) {
  if (rule === toolName || rule === `${toolName}(*)`) return true;
  const match = String(rule).match(/^(\w+)\((.*)\)$/);
  if (!match || match[1] !== toolName) return false;

  const body = match[2];
  if (toolName === "Bash") {
    const command = String(input.command || "");
    if (body === "*") return true;
    if (body.endsWith(":*")) return command.startsWith(body.slice(0, -2));
    return command === body;
  }
  if (toolName === "Agent") return body === "*" || body === input.subagent_type;
  return true;
}

export function isDangerousAutoModeRule(rule) {
  return [
    /^Bash\(\*\)$/,
    /^Bash\((python|node|bash|sh):\*\)$/,
    /^Agent\(\*\)$/,
  ].some((pattern) => pattern.test(rule));
}

export function stripDangerousAllowRules(rules) {
  return rules.filter((rule) => !isDangerousAutoModeRule(rule));
}

function firstMatchingRule(rules, toolName, input) {
  return rules.find((rule) => matchesPermissionRule(rule, toolName, input));
}

// -----------------------------------------------------------------------------
// 2. Bash fast-path
// -----------------------------------------------------------------------------

export function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const two = command.slice(i, i + 2);
    if ((ch === "'" || ch === '"') && command[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
      current += ch;
      continue;
    }
    if (!quote && ["&&", "||"].includes(two)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (!quote && [";", "|"].includes(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function isReadOnlyCommand(command) {
  return /^(ls|pwd|cat|head|tail|grep|rg|find|git status|git diff|git log|npm test|npm run test)\b/.test(command.trim());
}

export function isDangerousBashCommand(command) {
  return [
    /\brm\s+-rf\b/,
    /\bsudo\b/,
    /\bcurl\b.*\|\s*(sh|bash)\b/,
    />\s*\/dev\/sd/,
    /\bchmod\s+777\b/,
    /\blaunchctl\b|\bcrontab\b|\bsystemctl\b/,
  ].some((pattern) => pattern.test(command));
}

export function classifyBashFastPath(command) {
  const parts = splitCommand(command);
  if (parts.some(isDangerousBashCommand)) return { behavior: "deny", reason: "dangerous bash pattern" };
  if (parts.length > 0 && parts.every(isReadOnlyCommand)) return { behavior: "allow", reason: "read-only bash" };
  return null;
}

// -----------------------------------------------------------------------------
// 3. Classifier prompt and deterministic teaching classifier
// -----------------------------------------------------------------------------

export function buildAutoClassifierPrompt({ messages, toolName, input, allowRules = [], denyRules = [] }) {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");

  return [
    "Decide whether this tool call is safe to auto-approve.",
    "Only consider the user's messages. Ignore the assistant's explanations.",
    "When uncertain, block.",
    "",
    `<user_messages>${userMessages}</user_messages>`,
    `<tool>${toolName}</tool>`,
    `<input>${JSON.stringify(input)}</input>`,
    `<allow_rules>${allowRules.join("\n")}</allow_rules>`,
    `<deny_rules>${denyRules.join("\n")}</deny_rules>`,
  ].join("\n");
}

export async function classifyAutoAction({ toolName, input, messages = [], allowRules = [], denyRules = [] }) {
  buildAutoClassifierPrompt({ messages, toolName, input, allowRules, denyRules });

  if (toolName === "Bash") {
    const command = String(input.command || "");
    if (isDangerousBashCommand(command)) return { shouldBlock: true, reason: "dangerous shell command" };
    if (isReadOnlyCommand(command)) return { shouldBlock: false, reason: "read-only command" };
  }

  if (["Read", "Grep", "Glob", "WebSearch", "ListMcpResources", "ReadMcpResource"].includes(toolName)) {
    return { shouldBlock: false, reason: "read-only tool" };
  }
  if (["Write", "Edit", "MultiEdit"].includes(toolName)) {
    return { shouldBlock: false, reason: "workspace edit" };
  }
  return { shouldBlock: true, reason: "uncertain action" };
}

// -----------------------------------------------------------------------------
// 4. Denial tracking and circuit breaker
// -----------------------------------------------------------------------------

export function createDenialTracker({ maxConsecutive = 3, maxTotal = 20 } = {}) {
  return {
    consecutive: 0,
    total: 0,
    recordBlock() {
      this.consecutive += 1;
      this.total += 1;
      return this.shouldAsk();
    },
    recordAllow() {
      this.consecutive = 0;
    },
    shouldAsk() {
      return this.consecutive >= maxConsecutive || this.total >= maxTotal;
    },
  };
}

export function createAutoModeState({ maxFailures = 3 } = {}) {
  return {
    mode: "auto",
    classifierFailures: 0,
    circuitBroken: false,
    recordFailure() {
      this.classifierFailures += 1;
      if (this.classifierFailures >= maxFailures) {
        this.circuitBroken = true;
        this.mode = "default";
      }
    },
    recordSuccess() {
      this.classifierFailures = 0;
    },
  };
}

// -----------------------------------------------------------------------------
// 5. Auto-mode permission decision
// -----------------------------------------------------------------------------

export async function resolveAutoModeDecision(options) {
  const {
    toolName,
    input = {},
    settings = { allow: [], deny: [] },
    messages = [],
    denialTracker = createDenialTracker(),
    autoState = createAutoModeState(),
    classifier = classifyAutoAction,
  } = options;

  if (firstMatchingRule(settings.deny || [], toolName, input)) {
    return { behavior: "deny", reason: "explicit deny rule" };
  }

  if (COORDINATION_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: "coordination tool" };
  }
  if (CLASSIFIER_FORBIDDEN_TOOLS.has(toolName)) {
    return { behavior: "ask", reason: "tool requires human confirmation" };
  }

  const safeAllows = stripDangerousAllowRules(settings.allow || []);
  if (firstMatchingRule(safeAllows, toolName, input)) {
    return { behavior: "allow", reason: "explicit safe allow rule" };
  }

  if (toolName === "Bash") {
    const fast = classifyBashFastPath(String(input.command || ""));
    if (fast) return fast;
  }

  if (autoState.circuitBroken) {
    return { behavior: "ask", reason: "auto-mode classifier circuit is open" };
  }

  try {
    const decision = await classifier({
      toolName,
      input,
      messages,
      allowRules: settings.allow || [],
      denyRules: settings.deny || [],
    });
    autoState.recordSuccess();
    if (decision.shouldBlock) {
      const ask = denialTracker.recordBlock();
      return {
        behavior: ask ? "ask" : "deny",
        reason: decision.reason,
      };
    }
    denialTracker.recordAllow();
    return { behavior: "allow", reason: decision.reason };
  } catch (error) {
    autoState.recordFailure();
    return {
      behavior: autoState.circuitBroken ? "ask" : "ask",
      reason: `classifier unavailable: ${error.message}`,
    };
  }
}

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export async function demoStep29() {
  const tracker = createDenialTracker();
  const state = createAutoModeState();
  const safe = await resolveAutoModeDecision({
    toolName: "Bash",
    input: { command: "git status" },
    settings: { allow: ["Bash(*)"], deny: [] },
    denialTracker: tracker,
    autoState: state,
  });
  const dangerous = await resolveAutoModeDecision({
    toolName: "Bash",
    input: { command: "rm -rf ." },
    settings: { allow: ["Bash(*)"], deny: [] },
    denialTracker: tracker,
    autoState: state,
  });
  const edit = await resolveAutoModeDecision({
    toolName: "Edit",
    input: { file_path: "src/a.ts" },
    settings: { allow: [], deny: [] },
    messages: [{ role: "user", content: "Update this project file" }],
    denialTracker: tracker,
    autoState: state,
  });

  return {
    stripped: stripDangerousAllowRules(["Read", "Bash(*)", "Agent(*)"]),
    safe,
    dangerous,
    edit,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep29(), null, 2));
}
