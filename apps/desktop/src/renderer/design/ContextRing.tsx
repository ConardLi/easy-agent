import { cn } from "./primitives";

export function ContextRing({
  used,
  total,
  size = 16,
  stroke = 2.25,
  className,
}: {
  used: number;
  total: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const ratio = Math.min(1, total > 0 ? used / total : 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = ratio > 0.9 ? "var(--danger)" : ratio > 0.75 ? "var(--warning)" : "var(--accent)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("-rotate-90", className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(ratio, 0.015))}
        style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.16,1,0.3,1), stroke 300ms" }}
      />
    </svg>
  );
}
