# Easy Agent

在终端里干活的 Coding Agent：读代码、改文件、跑命令，每一步都在你定的权限规则里。

![Easy Agent banner](https://raw.githubusercontent.com/ConardLi/easy-agent/main/public/img/banner.jpeg)

Easy Agent（命令 `eagent`）就在你的仓库旁边运行。把任务说给它，它会先想好怎么做，再读文件、改代码、跑测试或 Shell 命令，最后把结果告诉你。凡是会改动机器的操作，都要先过权限规则和工作区信任检查，需要的话还可以放进系统级沙箱里跑。模型方面支持 Anthropic、OpenAI 兼容接口、Gemini 和本地模型。

代码除了能跑，也照着让人读懂来写。模型通信、Agentic Loop、工具、权限、上下文管理和各套扩展机制分层放置。下文链接的文档讲清了安全相关部分怎么工作、为什么这样设计；[学习路线](./docs/learning-path.zh-CN.md)按顺序把各层串起来，附带代码快照，适合想自己造一个 Agent、或者在它基础上做定制的工程师。

> English documentation: [README.md](./README.md)

## 能用它做什么

- 熟悉一个陌生的代码库：问它某段逻辑在哪儿处理、一个流程怎么走、改一处会牵连哪些地方。
- 跨多个文件改代码，看完 diff 再决定留不留，改错了用 `/rewind` 撤回。
- 跑构建和测试，读报错，一轮轮修到通过。
- 先在只读的 Plan Mode 里把方案定下来，再动手执行。
- 写进脚本：把输入管道给 `eagent -p`，在 CI 或 Shell 脚本里读 text、JSON 或 NDJSON 输出。
- 接入自己的工具：MCP Server、Skills、自定义 Agent、Hooks 和插件。

## 安装

运行要求：Node.js 22 或更高版本、npm，以及至少一个受支持模型服务的凭证。

```bash
npm install -g --ignore-scripts eagent
eagent --version
```

不想安装，也可以直接试：

```bash
npx --yes eagent@latest
```

macOS 和 Linux 另有一个安装脚本。它会检查 Node.js，用 `--ignore-scripts` 安装同一个 npm 包，再确认 `eagent` 已在 `PATH` 里。它不会替你装 Node.js，也不会执行包的生命周期脚本。

```bash
curl -fsSL https://raw.githubusercontent.com/ConardLi/easy-agent/main/install.sh | sh
```

安装后有两个命令：`eagent`，以及长命令名 `easy-agent`。

## 快速上手

```bash
export ANTHROPIC_AUTH_TOKEN="your-token"
cd your-project
eagent
```

第一次在某个目录启动时，Easy Agent 会问你是否信任这个目录。之后直接输入需求就行，比如「讲讲这个仓库的请求是怎么鉴权的」。输入 `/help` 查看命令，按 Ctrl+D 退出。

## 核心能力

- 文件与代码工具：Read、Write、Edit、MultiEdit、Glob、Grep、Bash，Windows 上用 PowerShell
- Web 与外部工具：WebFetch、WebSearch、[MCP Tools 与 Resources](./docs/mcp.md)
- 安全执行：Allow/Ask/Deny 规则、Plan Mode、Auto Mode、工作区信任、[Hooks](./docs/hooks.md)、[受控子进程](./docs/subprocesses.md)、[本地私有数据保护](./docs/local-data-security.md)，以及 macOS 和 Linux 上[默认失败即阻断的 Shell 沙箱](./docs/sandbox-security.md)
- 长任务：TodoWrite、持久化任务图、Sub-Agent、后台运行、Git Worktree 隔离、[Agent Teams](./docs/agent-teams.md)
- 上下文与连续性：[可靠持久化](./docs/persistence.md)、Resume、上下文压缩、Token 预算、项目记忆（`AGENTS.md` / `AGENT.md`）、文件检查点和 Rewind
- 扩展能力：Skills、自定义 Agent、Slash Commands、Output Styles、Hooks、MCP Server、插件和静态 Marketplace
- 使用方式：交互式终端界面、[Headless text/JSON/NDJSON 输出](./docs/headless-output.md)、可嵌入其他程序的[会话 SDK](./docs/sdk.md)（`eagent/sdk`）、供编辑器和桌面端使用的 [stdio JSON-RPC 模式](./docs/rpc.md)（`eagent --rpc`）、图片与截图、多种模型协议

## 支持的平台

| 平台 | 支持情况 | Shell 工具 | Shell 沙箱 |
|---|---|---|---|
| macOS | 支持 | Bash | Seatbelt，需要 `rg` |
| Linux、WSL2 | 支持 | Bash | bubblewrap，需要 `bubblewrap`、`socat`、`rg` 和非特权 user namespace |
| Windows | 支持，但没有沙箱 | PowerShell | 不可用；开启了失败即阻断的沙箱时，PowerShell 会被拦下 |

- 所有平台都要求 Node.js 22 或更高版本，版本太低会直接退出并说明原因。
- 安装脚本 `install.sh` 只支持 macOS 和 Linux，Windows 请用 npm 安装。
- Windows 上的本地数据靠用户目录的 ACL 保护，没有 POSIX 的 `0600`/`0700` 权限位，`/doctor` 会提示这一点。
- 粘贴剪贴板图片时，macOS 需要 `pngpaste` 或 `osascript`，Linux 需要 `xclip` 或 `xsel`。

各平台的沙箱配置见[沙箱安全说明](./docs/sandbox-security.md)，里面也讲了 Ubuntu 用 AppArmor 限制 user namespace 时怎么处理。

## 安全模型

Easy Agent 默认两件事都可能发生：模型会犯错，你打开的仓库可能带着恶意配置。所以它用几道互相独立的关口限制一次会话能做的事：

- **权限规则**：改文件、跑命令、访问网络的工具调用，都要按 allow、ask、deny 规则检查，deny 永远优先。默认模式下，没被放行的操作都会先问你；能确认是只读的 Bash 命令可以直接执行（[判定规则](./docs/bash-read-only-security.md)）。
- **权限模式**：`default` 在有风险的操作前询问；`plan`（`--plan`）只开放只读工具；`auto`（`--auto`）交给分类器判断，安全的直接放行，危险的拦下，拿不准再问你。Headless（`-p`）下，需要询问的调用一律拒绝，除非显式加上 `--dangerously-skip-permissions`，而且 deny 规则照样生效。
- **工作区信任**：目录被信任之前，项目配置、`.env`、项目里的 MCP Server、Hooks、插件和模型 Profile 都不会生效。信任记录存在你的用户目录里，仓库没法自己给自己“授信”，项目文件也不能覆盖你从 Shell 继承来的凭据（[详细说明](./docs/configuration-security.md)）。
- **路径边界**：文件工具会解析真实路径，不会顺着符号链接跑出工作区和额外允许的目录（[详细说明](./docs/workspace-path-security.md)）。
- **Shell 沙箱**：设置 `sandbox.enabled` 后，Bash 在系统沙箱里运行，写入只限白名单，网络走代理过滤。沙箱起不来时，命令会被拦下，不会悄悄改成无沙箱执行（[详细说明](./docs/sandbox-security.md)）。
- **本地数据**：会话、配置、信任记录和日志只有你自己的账户能读。流式调试日志默认关闭，打开后也会脱敏凭据（[详细说明](./docs/local-data-security.md)）。

Easy Agent 不上报任何统计或遥测数据。它只会向这些地方发请求：你配置的模型服务、你添加的 MCP Server 和插件源，以及在你允许时 WebFetch/WebSearch 访问的地址。`/doctor` 会探测一下已配置的模型服务端点能不能连通。

## 配置

配置是 JSON 文件，按下面的顺序合并，越往后优先级越高：

1. 用户级：`~/.easy-agent/settings.json`
2. 项目级：`<project>/.easy-agent/settings.json`（可提交共享，目录受信任后才生效）
3. 本地级：`<project>/.easy-agent/settings.local.json`（个人配置，目录受信任后才生效）
4. 命令行：`--settings <file>`、`--model`、`--permission-mode` 等参数
5. 托管策略：macOS 为 `/Library/Application Support/EasyAgent/managed-settings.json`，Linux 为 `/etc/easy-agent/managed-settings.json`，Windows 为 `%PROGRAMDATA%\EasyAgent\managed-settings.json`

项目里的 `.env` 在项目级和本地级配置之后应用，同样只在目录受信任时生效。各项功能开关见[配置与功能开关](./docs/configuration.md)。

使用原始 Anthropic 模型名时，配好环境变量就够了：

```bash
export ANTHROPIC_AUTH_TOKEN="your-token"
export ANTHROPIC_MODEL="claude-sonnet-4-20250514" # 可选
eagent
```

具名的 Anthropic、OpenAI 兼容、Gemini 和本地模型 Profile 写在 `settings.json` 里：

```json
{
  "defaultModel": "gpt",
  "models": {
    "gpt": {
      "protocol": "openai-chat",
      "model": "gpt-5.1",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}"
    },
    "gemini": {
      "protocol": "gemini",
      "model": "gemini-2.5-pro",
      "apiKey": "${GEMINI_API_KEY}"
    },
    "ollama": {
      "protocol": "openai-chat",
      "model": "qwen2.5-coder",
      "baseURL": "http://localhost:11434/v1"
    }
  }
}
```

用 `eagent --model gpt` 启动，或在 REPL 里执行 `/model gpt` 切换 Profile。

| 环境变量 | 用途 |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Anthropic API Token 或兼容网关 Token |
| `ANTHROPIC_BASE_URL` | 可选的 Anthropic 兼容端点 |
| `ANTHROPIC_MODEL` | 默认的原始 Anthropic 模型名 |
| `OPENAI_API_KEY` | OpenAI 兼容 Profile 引用的 Key |
| `GEMINI_API_KEY` | Gemini Profile 引用的 Key |
| `WEB_SEARCH_API_KEY` | 可选的 WebSearch 服务 Key |

运行 `/config list`、`/model list` 或 `/doctor` 可以查看最终生效的配置，凭据值一律脱敏显示。

## 数据存放位置

| 位置 | 内容 |
|---|---|
| `~/.easy-agent/settings.json` | 用户级配置 |
| `~/.easy-agent/state.json` | 工作区信任记录和本机状态 |
| `~/.easy-agent/AGENT.md` | 每个会话都会加载的用户级记忆 |
| `~/.easy-agent/projects/` | 会话记录（JSONL）和各项目的记忆 |
| `~/.easy-agent/file-history/` | `/rewind` 用到的文件检查点 |
| `~/.easy-agent/tasks/`、`plans/`、`teams/` | 任务图、Plan Mode 计划、Agent Team 状态 |
| `~/.easy-agent/skills/`、`agents/`、`commands/`、`output-styles/` | 用户级扩展 |
| `~/.easy-agent/plugins/`、`mcp/` | 已安装的插件，MCP 的 OAuth 凭据和产物 |
| `~/.easy-agent/stream-debug.log` | 只在设置 `EASY_AGENT_DEBUG_STREAM=1` 时生成 |
| `<project>/.easy-agent/` | 项目级配置、本地配置和项目级扩展 |
| `<project>/AGENTS.md`、`<project>/AGENT.md` | 你自己写或用 `/init` 生成的项目记忆；两个都有时都会加载，`AGENTS.md` 在前 |
| `<git root>/.easy-agent/worktrees/` | 隔离运行的 Sub-Agent 使用的 Git Worktree |

在 macOS 和 Linux 上，`~/.easy-agent` 以 `0700` 权限创建，敏感文件为 `0600`。卸载 npm 包不会删除这个目录，想清掉全部数据需要手动删除。

## 常用方式

```bash
eagent                         # 交互式 REPL
eagent --model gpt             # 选择模型 Profile
eagent --plan                  # 只读计划模式
eagent --auto                  # 分类器辅助的权限模式
eagent --resume                # 恢复最近一次会话
eagent --resume <session-id>   # 恢复指定会话
eagent -p "总结这个仓库"                         # Headless 文本输出
eagent --trust-project-config -p "总结这个仓库"  # 本次运行启用已检查过的项目配置
eagent -p "列出可用工具" --output-format json   # 机器可读输出
git diff | eagent -p "审查这个补丁"              # 合并 stdin 与 Prompt
```

结构化 JSON 与 NDJSON 消息遵循带版本号的 [Headless 输出 Schema](./docs/headless-output.md)。成本算不出来时返回 `null`，不会当成零成本。

运行 `eagent --help` 查看全部启动参数。常用的 REPL 命令：

| 命令 | 用途 |
|---|---|
| `/help` | 查看命令和快捷键 |
| `/model`、`/mode`、`/think`、`/effort` | 控制模型与推理行为 |
| `/config`、`/status`、`/doctor`、`/context` | 检查配置和运行状态 |
| `/resume`、`/history`、`/export`、`/copy` | 管理会话与输出 |
| `/rewind`、`/diff` | 查看或恢复文件改动 |
| `/permissions` | 查看权限规则 |
| `/skills`、`/agents`、`/hooks`、`/mcp` | 查看已加载的扩展 |
| `/plugin`、`/marketplace` | 安装和管理插件 |
| `/memory` | 查看或编辑项目记忆 |

## 升级与卸载

升级全局包，或者重新运行安装脚本：

```bash
npm install -g --ignore-scripts eagent@latest
```

卸载：

```bash
npm uninstall -g eagent
```

卸载 npm 包时，`~/.easy-agent/` 下的配置和会话会保留下来。

## 故障排查

1. 运行 `eagent --version`，再用 `node --version` 确认 Node.js 版本。
2. 在 Easy Agent 里运行 `/doctor`，检查凭证、配置、MCP、插件、沙箱支持和目录写入权限。
3. 运行 `/status` 和 `/config list`，确认当前模型和配置来源。
4. 全局安装成功却找不到 `eagent` 时，把 `npm prefix -g` 对应的全局 bin 目录加进 `PATH`，再开一个新 Shell。
5. 能复现的问题请提交到 [GitHub Issues](https://github.com/ConardLi/easy-agent/issues)。

提交 Issue 时，不要贴 API Key、`.env` 内容或私密 Prompt。

## 架构

Easy Agent 把运行时分成五层，各管各的：

```text
终端 UI
    ↓
QueryEngine（多轮编排）
    ↓
Agentic Loop（推理 → 工具 → 观察）
    ↓
工具与权限执行
    ↓
Provider API 与流式适配
```

npm 包里是一个可读的 ESM 单文件 bundle，附带 source map（只含路径，不内嵌源码），用户报错时的堆栈能对上真实的源码行。bundle 里打进去的第三方代码，许可证都列在 `dist/THIRD_PARTY_LICENSES.txt`。锁定版本的 `@anthropic-ai/sandbox-runtime` 依赖提供各平台进程隔离所需的组件。

## 本地开发

```bash
git clone https://github.com/ConardLi/easy-agent.git
cd easy-agent
npm install
npm run dev
```

`npm run verify:production` 是 Pull Request 用的离线门禁，`npm run verify:release` 是完整的发布门禁。细节见[测试说明](./docs/testing.md)和[发布流程](./docs/releasing.md)。

想一步步看这个 Agent 是怎么搭起来的，可以看[学习路线](./docs/learning-path.md)（[中文版](./docs/learning-path.zh-CN.md)），里面列了开发过程的各个里程碑和对应的代码快照。

## 贡献

项目还在快速演进，暂时不接收外部 Pull Request。欢迎提交带明确复现步骤的 Issue。

## License

[MIT](./LICENSE)。bundle 里的第三方包沿用各自的许可证，见安装包中的 `dist/THIRD_PARTY_LICENSES.txt`。
