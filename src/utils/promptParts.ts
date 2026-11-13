/**
 * Prompt text in parts, each with the component it comes from: the skill
 * listing line of one skill, the text of one rule file. Request records split
 * the system prompt along these parts.
 */

export interface PromptPart {
  /** Component id, such as `prompt_section:skills`, `skill:project:review`, or `rule:/repo/AGENT.md`. */
  component: string;
  text: string;
}

/**
 * Parts of `lines.join("\n")`: each line keeps the newline after it, and
 * neighbouring lines of one component become one part.
 */
export function joinLineParts(lines: readonly PromptPart[]): PromptPart[] {
  const parts: PromptPart[] = [];
  lines.forEach((line, index) => {
    const text = index < lines.length - 1 ? `${line.text}\n` : line.text;
    const last = parts.at(-1);
    if (last && last.component === line.component) last.text += text;
    else parts.push({ component: line.component, text });
  });
  return parts;
}

export const joinParts = (parts: readonly PromptPart[]): string => parts.map((part) => part.text).join("");
