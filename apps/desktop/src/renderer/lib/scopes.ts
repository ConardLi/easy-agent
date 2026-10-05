import { FolderOpen, Globe, HardDrive, Settings2, Shield } from "lucide-react";
import type { ConfigScope } from "../../shared/agent";

/** A settings file the client writes. */
export type WriteScope = ConfigScope;
/** Any settings layer, including command-line flags and managed policy, which the client only reads. */
export type SettingLayer = WriteScope | "flag" | "policy";

export const WRITE_SCOPES: WriteScope[] = ["user", "project", "local"];

export const SCOPE_LABEL: Record<SettingLayer, string> = { user: "全局", project: "项目", local: "本机", flag: "启动参数", policy: "策略" };
export const SCOPE_FILE: Record<SettingLayer, string> = {
  user: "~/.easy-agent/settings.json",
  project: ".easy-agent/settings.json",
  local: ".easy-agent/settings.local.json",
  flag: "--settings",
  policy: "managed-settings.json",
};
export const SCOPE_HINT: Record<WriteScope, string> = {
  user: "对你的所有项目生效",
  project: "提交到仓库，团队成员共享",
  local: "只在这台机器上生效，不提交",
};
export const SCOPE_ICON = { user: Globe, project: FolderOpen, local: HardDrive, flag: Settings2, policy: Shield } as const;
