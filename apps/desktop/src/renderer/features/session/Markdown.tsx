import { Check, Copy } from "lucide-react";
import "./prose.css";
import { Children, isValidElement, memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HighlighterCore } from "shiki/core";
import { useUi } from "../../state/ui";
import { cn, IconButton, Tooltip } from "../../design/primitives";

let highlighter: Promise<HighlighterCore> | null = null;

/** Load only the grammars and themes the conversation uses, with the JS regex engine (no wasm). */
function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import("shiki/dist/themes/vitesse-light.mjs"), import("shiki/dist/themes/vitesse-dark.mjs")],
      langs: [
        import("shiki/dist/langs/typescript.mjs"),
        import("shiki/dist/langs/tsx.mjs"),
        import("shiki/dist/langs/javascript.mjs"),
        import("shiki/dist/langs/json.mjs"),
        import("shiki/dist/langs/bash.mjs"),
        import("shiki/dist/langs/markdown.mjs"),
        import("shiki/dist/langs/css.mjs"),
        import("shiki/dist/langs/yaml.mjs"),
        import("shiki/dist/langs/diff.mjs"),
        import("shiki/dist/langs/python.mjs"),
      ],
    }),
  );
  return highlighter;
}

async function highlight(code: string, lang: string): Promise<string> {
  const h = await loadHighlighter();
  const alias: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", md: "markdown", yml: "yaml", py: "python" };
  const name = alias[lang] ?? lang;
  return h.codeToHtml(code, {
    lang: h.getLoadedLanguages().includes(name) ? name : "text",
    themes: { light: "vitesse-light", dark: "vitesse-dark" },
    defaultColor: false,
  });
}

const LANG_LABEL: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  json: "JSON",
  bash: "Shell",
  shell: "Shell",
  md: "Markdown",
  css: "CSS",
  yaml: "YAML",
  text: "Text",
  python: "Python",
};

export function CopyButton({ text, className, label = "复制" }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useUi((s) => s.toast);
  return (
    <Tooltip content={done ? "已复制" : label}>
      <IconButton
        size="sm"
        className={className}
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(text).catch(() => {});
          setDone(true);
          toast("已复制到剪贴板");
          setTimeout(() => setDone(false), 1400);
        }}
      >
        {done ? <Check className="text-success" /> : <Copy />}
      </IconButton>
    </Tooltip>
  );
}

export function CodeBlock({ code, lang, live }: { code: string; lang: string; live?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (live) return;
    let alive = true;
    void highlight(code, lang).then((out) => alive && setHtml(out));
    return () => {
      alive = false;
    };
  }, [code, lang, live]);

  return (
    <div className="group/code overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex h-8 items-center justify-between border-b border-line pl-3.5 pr-1.5">
        <span className="text-[11.5px] font-medium text-fg-3">{LANG_LABEL[lang] ?? lang}</span>
        <CopyButton text={code} className="opacity-0 transition-opacity group-hover/code:opacity-100" />
      </div>
      <div className="scroll-thin overflow-x-auto px-3.5 py-3">
        {html && !live ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output of local text
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="shiki">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function components(live: boolean): Components {
  return {
    pre({ children }) {
      const child = Children.toArray(children)[0];
      const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? "") : "";
      const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "text";
      return <CodeBlock code={textOf(children).replace(/\n$/, "")} lang={lang} live={live} />;
    },
    a({ children, href }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    table({ children }) {
      return (
        <div className="scroll-thin overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const staticComponents = components(false);
const liveComponents = components(true);

export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={cn("prose-agent", streaming && "stream-caret", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? liveComponents : staticComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
