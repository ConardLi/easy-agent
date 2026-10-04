export type BashReadOnlyReason =
  | "read_only"
  | "empty"
  | "invalid_syntax"
  | "unsupported_syntax"
  | "unsupported_command"
  | "unsafe_arguments";

export interface ParsedBashCommand {
  name: string;
  args: string[];
}

export interface BashReadOnlyAnalysis {
  isReadOnly: boolean;
  reason: BashReadOnlyReason;
  detail: string;
  commands: ParsedBashCommand[];
}

export interface BashReadOnlyAnalysisOptions {
  platform?: NodeJS.Platform;
}

interface ParseSuccess {
  ok: true;
  commands: ParsedBashCommand[];
}

interface ParseFailure {
  ok: false;
  reason: "empty" | "invalid_syntax" | "unsupported_syntax";
  detail: string;
  commands: ParsedBashCommand[];
}

type ParseResult = ParseSuccess | ParseFailure;

function parseFailure(reason: ParseFailure["reason"], detail: string, commands: ParsedBashCommand[]): ParseFailure {
  return { ok: false, reason, detail, commands };
}

/**
 * Parse the shell subset eligible for automatic read-only approval.
 *
 * The accepted grammar contains plain commands joined by pipes, logical
 * operators, semicolons, or newlines. Anything outside this subset fails
 * closed and requires approval.
 */
function parseRestrictedCommandList(input: string, platform: NodeJS.Platform): ParseResult {
  const source = input.replace(/\r\n?/g, "\n");
  const windowsShell = platform === "win32";
  if (!source.trim()) return parseFailure("empty", "command is empty", []);

  const commands: ParsedBashCommand[] = [];
  let words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | null = null;
  let requiredCommandAfterSeparator = false;

  const flushWord = () => {
    if (!wordStarted) return;
    words.push(word);
    word = "";
    wordStarted = false;
  };

  const flushCommand = (): boolean => {
    flushWord();
    const [name, ...args] = words;
    words = [];
    if (!name) return false;
    commands.push({ name, args });
    return true;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;

    if (quote === "single") {
      if (char === "'") quote = null;
      else word += char;
      wordStarted = true;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
        wordStarted = true;
        continue;
      }
      if (char === "$" || char === "`" || (windowsShell && (char === "%" || char === "!" || char === "^"))) {
        return parseFailure("unsupported_syntax", "shell expansion requires approval", commands);
      }
      if (char === "\\") {
        const next = source[index + 1];
        if (next === undefined) return parseFailure("invalid_syntax", "trailing escape", commands);
        if (windowsShell) {
          word += char;
          wordStarted = true;
          continue;
        }
        if (next === "\n") {
          return parseFailure("unsupported_syntax", "line continuation requires approval", commands);
        }
        if (next === '"' || next === "$" || next === "`" || next === "\\") {
          word += next;
        } else {
          word += `\\${next}`;
        }
        wordStarted = true;
        index += 1;
        continue;
      }
      word += char;
      wordStarted = true;
      continue;
    }

    if (char === "'" && windowsShell) {
      return parseFailure("unsupported_syntax", "single quotes are not portable to the Windows shell", commands);
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      wordStarted = true;
      continue;
    }

    if (char === " " || char === "\t") {
      flushWord();
      continue;
    }

    if (char === "\\") {
      if (windowsShell) {
        word += char;
        wordStarted = true;
        continue;
      }
      const next = source[index + 1];
      if (next === undefined) return parseFailure("invalid_syntax", "trailing escape", commands);
      if (next === "\n") {
        return parseFailure("unsupported_syntax", "line continuation requires approval", commands);
      }
      word += next;
      wordStarted = true;
      index += 1;
      continue;
    }

    if (char === "$" || char === "`" || (windowsShell && (char === "%" || char === "!" || char === "^"))) {
      return parseFailure("unsupported_syntax", "shell expansion requires approval", commands);
    }
    if (char === ">" || char === "<") {
      return parseFailure("unsupported_syntax", "shell redirection requires approval", commands);
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") {
      return parseFailure("unsupported_syntax", "shell grouping requires approval", commands);
    }
    if (char === "*" || char === "?" || char === "[") {
      return parseFailure("unsupported_syntax", "unquoted pathname expansion requires approval", commands);
    }
    if (char === "#" && !wordStarted) {
      return parseFailure("unsupported_syntax", "shell comments require approval", commands);
    }

    if (char === "&") {
      if (source[index + 1] !== "&") {
        return parseFailure("unsupported_syntax", "background execution requires approval", commands);
      }
      if (!flushCommand()) return parseFailure("invalid_syntax", "missing command before &&", commands);
      requiredCommandAfterSeparator = true;
      index += 1;
      continue;
    }

    if (char === "|") {
      const operator = source[index + 1] === "|" ? "||" : "|";
      if (!flushCommand()) {
        return parseFailure("invalid_syntax", `missing command before ${operator}`, commands);
      }
      requiredCommandAfterSeparator = true;
      if (operator === "||") index += 1;
      continue;
    }

    if (char === ";" || char === "\n") {
      const hasCommand = flushCommand();
      if (!hasCommand) {
        if (char === "\n" && commands.length > 0 && !requiredCommandAfterSeparator) continue;
        return parseFailure("invalid_syntax", `missing command before ${char === "\n" ? "newline" : ";"}`, commands);
      }
      requiredCommandAfterSeparator = false;
      continue;
    }

    if (char === "\0") return parseFailure("invalid_syntax", "NUL byte is not valid shell input", commands);

    word += char;
    wordStarted = true;
    requiredCommandAfterSeparator = false;
  }

  if (quote !== null) return parseFailure("invalid_syntax", "unterminated quote", commands);
  if (flushCommand()) requiredCommandAfterSeparator = false;
  if (requiredCommandAfterSeparator) {
    return parseFailure("invalid_syntax", "missing command after control operator", commands);
  }
  if (commands.length === 0) return parseFailure("empty", "command is empty", []);
  return { ok: true, commands };
}

const SIMPLE_READ_ONLY_COMMANDS = new Set(["ls", "cat", "grep", "pwd", "which", "head", "tail", "wc"]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show"]);
const UNSAFE_GIT_OPTIONS = new Set(["--ext-diff", "--textconv", "--output", "--show-signature"]);
const UNSAFE_FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fls",
  "-fprintf",
]);
const UNSAFE_RG_OPTIONS = new Set(["--pre", "--hostname-bin"]);
const UNSAFE_FD_LONG_OPTIONS = new Set(["--exec", "--exec-batch"]);

function matchesOption(arg: string, option: string): boolean {
  return arg === option || arg.startsWith(`${option}=`);
}

function matchesLongOptionOrAbbreviation(arg: string, option: string): boolean {
  const name = arg.split("=", 1)[0]!;
  return name.startsWith("--") && name.length >= 3 && option.startsWith(name);
}

function validateGit(args: string[]): string | null {
  const [subcommand, ...subcommandArgs] = args;
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return `git subcommand ${subcommand ?? "<missing>"} is not read-only allowlisted`;
  }
  const unsafe = subcommandArgs.find(
    (arg) =>
      [...UNSAFE_GIT_OPTIONS].some(
        (option) => matchesOption(arg, option) || matchesLongOptionOrAbbreviation(arg, option),
      ) || arg.includes("%G"),
  );
  return unsafe ? `git option ${unsafe} can write files or execute external helpers` : null;
}

function validateFind(args: string[]): string | null {
  const unsafe = args.find((arg) => {
    const normalized = arg.toLowerCase();
    return [...UNSAFE_FIND_ACTIONS].some(
      (action) => normalized === action || (normalized.length >= 3 && action.startsWith(normalized)),
    );
  });
  return unsafe ? `find action ${unsafe} is not read-only` : null;
}

function validateRipgrep(args: string[]): string | null {
  const unsafe = args.find((arg) => [...UNSAFE_RG_OPTIONS].some((option) => matchesOption(arg, option)));
  return unsafe ? `rg option ${unsafe} can execute an external command` : null;
}

function validateFd(args: string[]): string | null {
  let optionsEnded = false;
  for (const arg of args) {
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) continue;
    if ([...UNSAFE_FD_LONG_OPTIONS].some((option) => matchesOption(arg, option))) {
      return `fd option ${arg} can execute an external command`;
    }
    if (/^-[^-]*[xX]/.test(arg)) {
      return `fd option ${arg} can execute an external command`;
    }
  }
  return null;
}

function findUnescapedDelimiter(script: string, delimiter: string, start: number): number {
  let escaped = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === delimiter) return index;
  }
  return -1;
}

function isSafeSedDisplayScript(script: string): boolean {
  const operation = script.at(-1);
  if (!operation || !"pPqQdDnlN=".includes(operation)) return false;
  const address = script.slice(0, -1);
  if (!address) return true;
  const parts = address.split(",");
  return parts.length <= 2 && parts.every((part) => part === "$" || /^[0-9]+$/.test(part));
}

function isSafeSedSubstitution(script: string): boolean {
  if (!script.startsWith("s") || script.length < 4) return false;
  const delimiter = script[1]!;
  if (/[A-Za-z0-9\\\s]/.test(delimiter)) return false;
  const patternEnd = findUnescapedDelimiter(script, delimiter, 2);
  if (patternEnd < 0) return false;
  const replacementEnd = findUnescapedDelimiter(script, delimiter, patternEnd + 1);
  if (replacementEnd < 0) return false;
  const flags = script.slice(replacementEnd + 1);
  return [...flags].every((flag) => "gIp0123456789".includes(flag));
}

function isSafeSedScript(script: string): boolean {
  if (!script || script.includes(";") || script.includes("\n") || script.includes("\r")) {
    return false;
  }
  return isSafeSedDisplayScript(script) || isSafeSedSubstitution(script);
}

function validateSed(args: string[]): string | null {
  const scripts: string[] = [];
  let optionsEnded = false;
  let hasExplicitExpression = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (
      !optionsEnded &&
      (arg === "-i" ||
        arg.startsWith("-i") ||
        matchesOption(arg, "--in-place") ||
        matchesLongOptionOrAbbreviation(arg, "--in-place"))
    ) {
      return `sed option ${arg} writes files`;
    }
    if (
      !optionsEnded &&
      (arg === "-f" ||
        arg.startsWith("-f") ||
        matchesOption(arg, "--file") ||
        matchesLongOptionOrAbbreviation(arg, "--file"))
    ) {
      return `sed option ${arg} loads an unverified program`;
    }
    if (!optionsEnded && (arg === "-e" || arg === "--expression")) {
      const expression = args[index + 1];
      if (expression === undefined) return `sed option ${arg} is missing its expression`;
      scripts.push(expression);
      hasExplicitExpression = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-e") && arg.length > 2) {
      scripts.push(arg.slice(2));
      hasExplicitExpression = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      hasExplicitExpression = true;
      continue;
    }
    if (!optionsEnded && /^-[nErsuz]+$/.test(arg)) continue;
    if (
      !optionsEnded &&
      ["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data"].includes(arg)
    ) {
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      return `sed option ${arg} is not read-only allowlisted`;
    }
    if (!hasExplicitExpression && scripts.length === 0) {
      scripts.push(arg);
    }
  }

  if (scripts.length === 0) return "sed program is missing";
  const unsafeScript = scripts.find((script) => !isSafeSedScript(script));
  if (unsafeScript !== undefined) return "sed program may write files or execute commands";
  return null;
}

function validateCommand(command: ParsedBashCommand): { supported: boolean; detail: string | null } {
  if (SIMPLE_READ_ONLY_COMMANDS.has(command.name)) {
    return { supported: true, detail: null };
  }

  const validators: Record<string, (args: string[]) => string | null> = {
    git: validateGit,
    find: validateFind,
    rg: validateRipgrep,
    fd: validateFd,
    sed: validateSed,
  };
  const validator = validators[command.name];
  if (!validator) {
    return { supported: false, detail: `command ${command.name} is not read-only allowlisted` };
  }
  return { supported: true, detail: validator(command.args) };
}

export function analyzeBashCommand(command: string, options: BashReadOnlyAnalysisOptions = {}): BashReadOnlyAnalysis {
  const parsed = parseRestrictedCommandList(command, options.platform ?? process.platform);
  if (!parsed.ok) {
    return {
      isReadOnly: false,
      reason: parsed.reason,
      detail: parsed.detail,
      commands: parsed.commands,
    };
  }

  for (const parsedCommand of parsed.commands) {
    const validation = validateCommand(parsedCommand);
    if (!validation.supported) {
      return {
        isReadOnly: false,
        reason: "unsupported_command",
        detail: validation.detail ?? "command is not read-only allowlisted",
        commands: parsed.commands,
      };
    }
    if (validation.detail) {
      return {
        isReadOnly: false,
        reason: "unsafe_arguments",
        detail: validation.detail,
        commands: parsed.commands,
      };
    }
  }

  return {
    isReadOnly: true,
    reason: "read_only",
    detail: "every command and argument is read-only allowlisted",
    commands: parsed.commands,
  };
}

export function isReadOnlyCommand(command: string, options?: BashReadOnlyAnalysisOptions): boolean {
  return analyzeBashCommand(command, options).isReadOnly;
}
