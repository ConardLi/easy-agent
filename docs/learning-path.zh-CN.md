# 学习路线

> English: [learning-path.md](./learning-path.md)

Easy Agent 从一次流式模型调用起步，分 37 个里程碑做到发布到 npm 的 CLI。脚手架之后的每个里程碑，在 [`step/`](../step) 下都有一份快照，只收当时新增的核心代码。后面的快照会 import 前面的，按顺序读最顺。快照和 `src/` 分开维护，想看当前产品的实现，请读 `src/`。

想弄明白一个终端 Coding Agent 是怎么一层层搭起来的，可以照着这些快照读：先是模型通信、终端 UI、工具和 Agentic Loop，再到权限、会话、上下文管理，最后是各套扩展机制。

| 里程碑 | 模块 | 快照 |
|---|---|---|
| 0 | 项目脚手架 | — |
| 1 | LLM 通信层 | [`step/step1.js`](../step/step1.js) |
| 2 | React/Ink 终端 UI | [`step/step2.js`](../step/step2.js) |
| 3 | Tool 接口与第一个工具 | [`step/step3.js`](../step/step3.js) |
| 4 | 核心 Agentic Loop | [`step/step4.js`](../step/step4.js) |
| 5 | 完整核心工具集 | [`step/step5.js`](../step/step5.js) |
| 6 | System Prompt 与上下文工程 | [`step/step6.js`](../step/step6.js) |
| 7 | 权限控制系统 | [`step/step7.js`](../step/step7.js) |
| 8 | QueryEngine 多轮编排 | [`step/step8.js`](../step/step8.js) |
| 9 | 会话持久化与恢复 | [`step/step9.js`](../step/step9.js) |
| 10 | 项目记忆系统 | [`step/step10.js`](../step/step10.js) |
| 11 | 上下文压缩 | [`step/step11.js`](../step/step11.js) |
| 12 | Token 预算精细管理 | [`step/step12.js`](../step/step12.js) |
| 13 | Plan Mode | [`step/step13.js`](../step/step13.js) |
| 14 | TodoWrite 会话任务跟踪 | [`step/step14.js`](../step/step14.js) |
| 15 | 持久化任务图 | [`step/step15.js`](../step/step15.js) |
| 16 | MCP 协议支持 | [`step/step16.js`](../step/step16.js) |
| 17 | Skills 系统 | [`step/step17.js`](../step/step17.js) |
| 18 | Sandbox | [`step/step18.js`](../step/step18.js) |
| 19 | Sub-Agent 与 Agent 定义系统 | [`step/step19.js`](../step/step19.js) |
| 20 | 后台执行与 Worktree 隔离 | [`step/step20.js`](../step/step20.js) |
| 21 | Agent Teams 与多 Agent 协作 | [`step/step21.js`](../step/step21.js) |
| 22 | Hooks 生命周期系统 | [`step/step22.js`](../step/step22.js) |
| 23 | Output Styles 与用户命令 | [`step/step23.js`](../step/step23.js) |
| 24 | 渲染体验升级 | [`step/step24.js`](../step/step24.js) |
| 25 | 配置系统完善 | [`step/step25.js`](../step/step25.js) |
| 26 | 文件历史与回滚 | [`step/step26.js`](../step/step26.js) |
| 27 | 错误处理与韧性 | [`step/step27.js`](../step/step27.js) |
| 28 | Headless 与管道模式 | [`step/step28.js`](../step/step28.js) |
| 29 | Auto Mode 分类器 | [`step/step29.js`](../step/step29.js) |
| 30 | 多 Provider 支持 | [`step/step30.js`](../step/step30.js) |
| 31 | Web、MultiEdit、MCP Resources 与 PowerShell | [`step/step31.js`](../step/step31.js) |
| 32 | 图片与截图多模态输入 | [`step/step32.js`](../step/step32.js) |
| 33 | 内置命令补全 | [`step/step33.js`](../step/step33.js) |
| 34 | Extended Thinking 控制与展示 | [`step/step34.js`](../step/step34.js) |
| 35 | Plugins 与 Marketplace | [`step/step35.js`](../step/step35.js) |
| 36 | 打包发布与文档 | [`step/step36.js`](../step/step36.js) |

里程碑 36 之后，产品又做了一轮生产化加固，涉及 Bash 只读判断、路径边界、配置信任、沙箱、本地数据权限、原子持久化、子进程上限、Agent Teams 并发、MCP 恢复、工具输入校验、Hooks、配置系统、用户输出和发布门禁。这些改动只体现在 `src/` 和 [`docs/`](./) 的文档里，快照没有跟着更新。
