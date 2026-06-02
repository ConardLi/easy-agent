# Easy Agent

一个从零开始、以开源方式完整复刻 Claude Code 体验的终端 Agent 工程项目。

![](./public/img/banner.jpeg)

Easy Agent 是一个长期演进的工程项目，目标是用 TypeScript 和 Node.js 逐步重建一个完整的本地 Agentic Coding System。它不是几个零散 Demo 的集合，而是一个面向真实工程能力的开源复刻项目：具备清晰架构、安全边界、多轮编排、本地工具执行能力，以及进一步走向完整 Claude Code 级开发体验所需的扩展能力。

这个仓库是该目标的开源实现主线。后续会逐步补充更完整的文档，当前 README 重点说明项目本身：它想做成什么、采用什么架构、目前推进到哪里。

> English version: see [README.md](./README.md)

## 项目愿景

Easy Agent 的目标，是成为一个严肃的、可持续演进的、本地 Coding Agent 开源复刻项目。

核心目标：

- 以开源方式完整复刻 Claude Code 风格工作流
- 保持架构清晰、职责明确、便于扩展
- 优先实现真实工程系统，而不是玩具示例
- 逐步演进为完整的本地 Agent CLI
- 为持久化、上下文压缩、MCP、Skills、Sandbox、Sub-Agent、多 Agent 协作、多 Provider 支持等能力保留稳定的扩展路径

## 当前状态

**当前阶段：** 阶段 27 —— 错误处理与韧性，下一阶段

当前项目已经完成到阶段 26 的教程化实现主线，包括 CLI、流式通信、工具执行、终端 UI、会话编排、上下文管理、MCP、Skills、Sandbox、Sub-Agent、后台 Agent 执行、Git Worktree 隔离、Agent Teams、Hooks 生命周期系统、Output Styles、用户自定义 Slash Commands、渲染体验升级、统一配置系统、项目信任、文件历史与回滚能力。阶段 27 是下一块重点：错误处理与韧性。

因此，当前的 Easy Agent 更适合被理解为一个正在稳步推进的开源复刻工程，而不是已经面向终端用户完全交付的成品。

## 架构设计

Easy Agent 按照五层架构推进：

```text
+---------------------------------------------------+
| 1. 交互层                                          |
|    终端 UI、输入处理、渲染输出                        |
+---------------------------------------------------+
| 2. 编排层                                          |
|    多轮会话流转、usage、命令控制                      |
+---------------------------------------------------+
| 3. 核心 Agentic Loop                               |
|    推理 -> 调工具 -> 观察结果 -> 继续推理              |
+---------------------------------------------------+
| 4. 工具层                                          |
|    文件、Shell、搜索等本地行动能力                    |
+---------------------------------------------------+
| 5. 通信层                                          |
|    与大模型之间的流式通信                             |
+---------------------------------------------------+
```

这种分层方式让系统更容易持续演进：

- **通信层** 负责模型输入输出
- **工具层** 负责向模型暴露行动能力
- **核心循环层** 负责单轮自主执行闭环
- **编排层** 负责多轮状态与控制流
- **交互层** 负责把整个运行时变成可用的终端产品

## 仓库结构

```text
easy-agent/
├── src/
│   ├── entrypoint/      # CLI 启动入口
│   ├── ui/              # React/Ink 终端界面
│   ├── core/            # agentic loop 与 query orchestration
│   ├── agents/          # 子 Agent 定义、注册表与运行器
│   ├── tools/           # 本地工具与工具注册系统
│   ├── services/        # 模型 API、MCP 与 Skills 服务
│   ├── permissions/     # 权限与安全控制
│   ├── context/         # system prompt 与上下文管理
│   ├── sandbox/         # Bash 沙箱 profile 与命令包装
│   ├── session/         # 会话持久化与历史
│   ├── state/           # Todo、Task、Agent 等运行时状态
│   ├── types/           # 共享领域类型
│   └── utils/           # env、config、log、辅助函数
├── package.json
├── tsconfig.json
├── README.md
└── README.zh-CN.md
```

## 路线图与当前进度

项目遵循一个 32 阶段路线图，以渐进方式完整复刻 Claude Code 风格系统。

| 阶段 | 模块 | 核心代码 | 状态 |
|---|---|---|---:|
| 0 | 项目脚手架 | `planned in step series` | ✅ 已完成 |
| 1 | LLM 通信层 | [`step/step1.js`](./step/step1.js) | ✅ 已完成 |
| 2 | React/Ink 终端 UI | [`step/step2.js`](./step/step2.js) | ✅ 已完成 |
| 3 | Tool 接口与第一个工具 | [`step/step3.js`](./step/step3.js) | ✅ 已完成 |
| 4 | 核心 Agentic Loop | [`step/step4.js`](./step/step4.js) | ✅ 已完成 |
| 5 | 完整核心工具集 | [`step/step5.js`](./step/step5.js) | ✅ 已完成 |
| 6 | System Prompt 与上下文工程 | [`step/step6.js`](./step/step6.js) | ✅ 已完成 |
| 7 | 权限控制系统 | [`step/step7.js`](./step/step7.js) | ✅ 已完成 |
| 8 | QueryEngine 多轮编排 | [`step/step8.js`](./step/step8.js) | ✅ 已完成 |
| 9 | 会话持久化与恢复 | [`step/step9.js`](./step/step9.js) | ✅ 已完成 |
| 10 | 项目记忆系统 | [`step/step10.js`](./step/step10.js) | ✅ 已完成 |
| 11 | 上下文压缩 | [`step/step11.js`](./step/step11.js) | ✅ 已完成 |
| 12 | Token 预算精细管理 | [`step/step12.js`](./step/step12.js) | ✅ 已完成 |
| 13 | Plan Mode | [`step/step13.js`](./step/step13.js) | ✅ 已完成 |
| 14 | TodoWrite 会话任务跟踪 | [`step/step14.js`](./step/step14.js) | ✅ 已完成 |
| 15 | 任务管理系统（V2） | [`step/step15.js`](./step/step15.js) | ✅ 已完成 |
| 16 | MCP 协议支持 | [`step/step16.js`](./step/step16.js) | ✅ 已完成 |
| 17 | Skills 系统 | [`step/step17.js`](./step/step17.js) | ✅ 已完成 |
| 18 | Sandbox | [`step/step18.js`](./step/step18.js) | ✅ 已完成 |
| 19 | Sub-Agent 与 Agent 定义系统 | [`step/step19.js`](./step/step19.js) | ✅ 已完成 |
| 20 | 后台执行与 Worktree 隔离 | [`step/step20.js`](./step/step20.js) | ✅ 已完成 |
| 21 | Agent Teams / 多 Agent 协作 | [`step/step21.js`](./step/step21.js) | ✅ 已完成 |
| 22 | Hooks 生命周期系统 | [`step/step22.js`](./step/step22.js) | ✅ 已完成 |
| 23 | Output Styles 与用户命令 | [`step/step23.js`](./step/step23.js) | ✅ 已完成 |
| 24 | 渲染体验升级 | [`step/step24.js`](./step/step24.js) | ✅ 已完成 |
| 25 | 配置系统完善 | [`step/step25.js`](./step/step25.js) | ✅ 已完成 |
| 26 | 文件历史与回滚 | [`step/step26.js`](./step/step26.js) | ✅ 已完成 |
| 27 | 错误处理与韧性 | `planned` | ⏳ 未开始 |
| 28 | 管道模式 / 非交互执行 | `planned` | ⏳ 未开始 |
| 29 | Auto Mode | `planned in step series` | 🚧 部分完成 |
| 30 | 多 Provider 支持 | `planned in step series` | ⏳ 未开始 |
| 31 | 打包发布与文档 | `planned in step series` | 🚧 部分完成 |

[`easy-agent/step/`](./step/) 目录中已经补充了教程化的里程碑核心代码，意味着每个已完成章节都可以直接对照学习、逐步复刻。

当前实现进度补充：

- 阶段 26 已在源码和 step 快照中完成。
- 阶段 27 错误处理与韧性是下一阶段，它会继续补强请求、工具执行和会话恢复链路。

## Easy Agent 是什么，以及它不是什么

**Easy Agent 是：**
- 一个开源复刻项目
- 一个系统工程实践项目
- 一个面向长期演进的本地 Coding Agent 实现
- 一个持续朝完整 Claude Code 级 CLI 推进的公开代码库

**Easy Agent 不是：**
- 一个单文件 Demo
- 一个只包了一层 Prompt 的 API 壳子
- 一个今天就已经完全完成的产品
- 任何私有课程内容的公开镜像

## 快速开始

### 环境要求

- Node.js
- npm
- Anthropic 兼容模型访问能力

### 环境变量

Easy Agent 当前支持以下环境变量：

- `ANTHROPIC_MODEL` —— 默认模型名
- `ANTHROPIC_BASE_URL` —— 自定义 API Base URL
- `ANTHROPIC_AUTH_TOKEN` —— API 鉴权 Token

### 安装

```bash
npm install
```

### 开发运行

```bash
npm run dev
```

### 构建运行

```bash
npm run build
npm start
```

### CLI 示例

```bash
agent --help
agent --model claude-sonnet-4-20250514
agent --plan
agent --auto
agent --dump-system-prompt
```

## 近期重点

接下来最重要的几个里程碑是：

1. 实现阶段 27 错误处理与韧性
2. 补齐阶段 27 教程文章和 `step/step27.js`
3. 继续推进管道模式与 Auto Mode
4. 准备多 Provider 架构与最终打包发布工作

## 贡献策略

Easy Agent **当前暂不接受外部贡献**。

项目仍处于高频演进阶段，整体实现、目录结构和开发约定都还可能持续变化。等项目进入更稳定、更适合维护协作的状态后，才会正式开放外部贡献。

在此之前，欢迎关注项目进展和公开路线图，但暂时不会接收 Pull Request 或外部代码贡献。

## License

MIT
