import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface Rule {
  id: string;
  pattern: RegExp;
  hint: string;
}

interface AllowedMatch {
  file: string;
  rule: string;
  text: string;
  reason: string;
}

interface ExcludedDirectory {
  dir: string;
  reason: string;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = "src";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);

const RULES: Rule[] = [
  {
    id: "roadmap-stage",
    pattern: /\b(?:[Ss]tage|[Pp]hase)\s+\d|[一二三四五六七八九十]期|阶段\s*\d/,
    hint: "describe the behavior instead of the roadmap stage that introduced it",
  },
  {
    id: "roadmap-plan",
    pattern: /DEVELOPMENT-PLAN|\bplan §|§\s?\d{2}\.\d|\b(?:later|future|next|upcoming)\s+(?:stage|phase)s?\b|[Ww]ill be implemented in/,
    hint: "track deferred work in an issue instead of a source comment",
  },
  {
    id: "reference-source",
    pattern: new RegExp(
      [
        String.raw`claude-code-source-code`,
        String.raw`\bsource(?:'s|\s+code(?:'s)?|-aligned)\b`,
        String.raw`\b(?:[Mm]irror(?:s|ed|ing)?|vs\.?|[Ll]ike|[Ff]rom|[Mm]atch(?:es|ing)?|same as)\s+(?:the\s+)?source\b`,
        // "the source" as a noun for the reference implementation; common
        // legitimate compounds ("the source file", "the source `.md`") pass.
        String.raw`\b[Tt]he source\b(?!\s+(?:` +
          "`" +
          String.raw`|(?:file|files|tree|order|path|paths|dir|directory|map|maps|text|branch|value|object|string|scope|label|location|repository|repo|marketplace|plugin|settings)\b))`,
        String.raw`\b[Tt]he (?:reference|original) (?:implementation|version|has|iterates|uses|additionally)\b`,
        String.raw`\b[Ss]ource ships\b`,
        "源码",
      ].join("|"),
    ),
    hint: "explain the constraint directly instead of pointing at the reference implementation",
  },
  {
    id: "teaching",
    pattern: /\b[Tt]eaching\b|\b[Tt]utorials?\b|教学|教程|复刻/,
    hint: "remove course and tutorial framing from production code",
  },
  {
    id: "simplification",
    pattern: /\b[Ss]implif(?:y|ied|ies|ication)\b|\b[Ww]e\s+(?:omit|drop|skip)\b|\b[Ff]aithfully\b|简化/,
    hint: "state the supported behavior and its limits instead of what was left out",
  },
];

const EXCLUDED_DIRECTORIES: ExcludedDirectory[] = [
  {
    dir: "src/scripts",
    reason:
      "Test and smoke scripts. They are not bundled into dist/eagent.js, and their stage-numbered file and npm script names are kept for command compatibility.",
  },
];

const ALLOWED_MATCHES: AllowedMatch[] = [
  {
    file: "src/styles/registry.ts",
    rule: "teaching",
    text: "HOW the agent answers (tone, structure, teaching behaviour)",
    reason: "The Explanatory and Learning output styles are a teaching feature for end users.",
  },
  {
    file: "src/styles/registry.ts",
    rule: "teaching",
    text: "the agent adds short \"Insight\" teaching blocks",
    reason: "Describes the user-visible Explanatory output style.",
  },
  {
    file: "src/styles/registry.ts",
    rule: "teaching",
    text: "the teaching styles set it true on purpose",
    reason: "Refers to the Explanatory and Learning output styles.",
  },
  {
    file: "src/styles/registry.ts",
    rule: "teaching",
    text: "the \"Insight\" teaching block",
    reason: "Names the shared prompt block of the Explanatory and Learning output styles.",
  },
  {
    file: "src/styles/registry.ts",
    rule: "teaching",
    text: "Balance teaching with task completion",
    reason: "Prompt text of the Explanatory output style sent to the model.",
  },
];

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

function isExcluded(relative: string): boolean {
  return EXCLUDED_DIRECTORIES.some(({ dir }) => relative === dir || relative.startsWith(`${dir}/`));
}

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(PROJECT_ROOT, dir), { withFileTypes: true })) {
    const relative = toPosix(path.join(dir, entry.name));
    if (isExcluded(relative)) continue;
    if (entry.isDirectory()) files.push(...(await collectFiles(relative)));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(relative);
  }
  return files;
}

interface Violation {
  file: string;
  line: number;
  rule: Rule;
  text: string;
}

async function main(): Promise<void> {
  const usedAllowances = new Set<AllowedMatch>();
  const violations: Violation[] = [];
  const files = (await collectFiles(SCAN_ROOT)).sort();

  for (const file of files) {
    const lines = (await readFile(path.join(PROJECT_ROOT, file), "utf8")).split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const rule of RULES) {
        if (!rule.pattern.test(text)) continue;
        const allowance = ALLOWED_MATCHES.find(
          (entry) => entry.file === file && entry.rule === rule.id && text.includes(entry.text),
        );
        if (allowance) {
          usedAllowances.add(allowance);
          continue;
        }
        violations.push({ file, line: index + 1, rule, text: text.trim() });
      }
    });
  }

  const staleAllowances = ALLOWED_MATCHES.filter((entry) => !usedAllowances.has(entry));

  for (const violation of violations) {
    process.stdout.write(
      `${violation.file}:${violation.line} [${violation.rule.id}] ${violation.text}\n  -> ${violation.rule.hint}\n`,
    );
  }
  for (const entry of staleAllowances) {
    process.stdout.write(`stale allowance: ${entry.file} [${entry.rule}] "${entry.text}"\n`);
  }

  process.stdout.write(
    `Source hygiene: scanned ${files.length} file(s) under ${SCAN_ROOT}/, ` +
      `${violations.length} violation(s), ${staleAllowances.length} stale allowance(s).\n`,
  );
  if (violations.length > 0 || staleAllowances.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
