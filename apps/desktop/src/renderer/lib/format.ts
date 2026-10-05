import type { DiffLine } from "../agent/viewModel";

let counter = 0;
export const uid = (prefix = "id"): string => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export function relativeTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function shortTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const days = Math.floor((now - at) / 86_400_000);
  if (days < 7) return relativeTime(at, now);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export type DayBucket = "置顶" | "今天" | "昨天" | "过去 7 天" | "更早";

export function dayBucket(at: number, now = Date.now()): Exclude<DayBucket, "置顶"> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t = startOfToday.getTime();
  if (at >= t) return "今天";
  if (at >= t - 86_400_000) return "昨天";
  if (at >= t - 7 * 86_400_000) return "过去 7 天";
  return "更早";
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export const money = (n: number): string => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) / 10)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Parse a unified-diff body (lines starting with ` `, `+`, `-`, or `@@`) into
 * numbered lines. `@@ -12,6 +12,9 @@` headers reset the counters.
 */
export function parsePatch(patch: string): { lines: DiffLine[]; added: number; removed: number } {
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const raw of patch.replace(/^\n/, "").replace(/\n$/, "").split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /-(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      lines.push({ type: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ type: "add", text: raw.slice(1), newNo: newNo++ });
      added++;
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++ });
      removed++;
    } else {
      lines.push({ type: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { lines, added, removed };
}

export const basename = (p: string): string => p.split("/").pop() ?? p;
export const dirname = (p: string): string => p.split("/").slice(0, -1).join("/");

export function languageOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return (
    ({ ts: "ts", tsx: "tsx", js: "js", mjs: "js", json: "json", md: "md", css: "css", sh: "bash", yml: "yaml", yaml: "yaml" } as Record<string, string>)[ext] ??
    "text"
  );
}
