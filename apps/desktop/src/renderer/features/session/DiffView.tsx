import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import type { DiffLine } from "../../agent/viewModel";
import { cn } from "../../design/primitives";

export function DiffStat({ added, removed, className }: { added?: number; removed?: number; className?: string }) {
  return (
    <span className={cn("tabular inline-flex items-center gap-1.5 font-mono text-[11.5px] font-medium", className)}>
      {added ? <span className="text-success">+{added}</span> : null}
      {removed ? <span className="text-danger">−{removed}</span> : null}
    </span>
  );
}

export function DiffView({ lines, collapseAfter = 14, className }: { lines: DiffLine[]; collapseAfter?: number; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = lines.length > collapseAfter + 4;
  const shown = collapsible && !expanded ? lines.slice(0, collapseAfter) : lines;

  return (
    <div className={cn("relative font-mono text-[12px] leading-[1.7]", className)}>
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {shown.map((line, i) =>
              line.type === "hunk" ? (
                <tr key={`h${i}`} className="bg-accent-softer text-fg-3">
                  <td colSpan={3} className="select-none px-3 py-0.5 text-[11px]">
                    {line.text}
                  </td>
                </tr>
              ) : (
                <tr key={`l${i}`} className={cn(line.type === "add" && "bg-[var(--diff-add)]", line.type === "del" && "bg-[var(--diff-del)]")}>
                  <td className="w-[1%] select-none whitespace-nowrap pl-3 pr-2 text-right text-[11px] text-fg-4 tabular">
                    {line.type === "add" ? line.newNo : line.oldNo}
                  </td>
                  <td
                    className={cn(
                      "w-[1%] select-none pr-2 text-center",
                      line.type === "add" ? "text-success" : line.type === "del" ? "text-danger" : "text-transparent",
                    )}
                  >
                    {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                  </td>
                  <td className={cn("whitespace-pre pr-4", line.type === "ctx" ? "text-fg-2" : "text-fg")}>{line.text || " "}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {collapsible && (
        <div className={cn(!expanded && "absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface via-surface/90 to-transparent pt-10")}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex h-8 w-full items-center justify-center gap-1.5 border-t border-line font-sans text-[12px] font-medium text-fg-3 transition-colors hover:text-fg"
          >
            <ChevronsUpDown className="size-3.5" />
            {expanded ? "收起" : `展开剩余 ${lines.length - collapseAfter} 行`}
          </button>
        </div>
      )}
    </div>
  );
}
