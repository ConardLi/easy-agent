# Learning path

> 中文版：[learning-path.zh-CN.md](./learning-path.zh-CN.md)

Easy Agent was developed in 37 milestones, from a single streaming model call to the published CLI. Each milestone after the scaffold has a snapshot under [`step/`](../step) that isolates the core code introduced at that point. Later snapshots import earlier ones, so they read best in order. The snapshots are maintained separately from `src/`; read `src/` for the current product.

The snapshots are useful if you want to study how a terminal coding agent is assembled layer by layer: model communication, the terminal UI, tools, the agentic loop, permissions, sessions, context management, and then the extension systems.

| Milestone | Area | Snapshot |
|---|---|---|
| 0 | Project scaffold | — |
| 1 | LLM communication layer | [`step/step1.js`](../step/step1.js) |
| 2 | React/Ink terminal UI | [`step/step2.js`](../step/step2.js) |
| 3 | Tool interface and first tool | [`step/step3.js`](../step/step3.js) |
| 4 | Core agentic loop | [`step/step4.js`](../step/step4.js) |
| 5 | Complete core toolset | [`step/step5.js`](../step/step5.js) |
| 6 | System prompt and context engineering | [`step/step6.js`](../step/step6.js) |
| 7 | Permission control system | [`step/step7.js`](../step/step7.js) |
| 8 | QueryEngine multi-turn orchestration | [`step/step8.js`](../step/step8.js) |
| 9 | Session persistence and restore | [`step/step9.js`](../step/step9.js) |
| 10 | Project memory system | [`step/step10.js`](../step/step10.js) |
| 11 | Context compaction | [`step/step11.js`](../step/step11.js) |
| 12 | Fine-grained token budget management | [`step/step12.js`](../step/step12.js) |
| 13 | Plan Mode | [`step/step13.js`](../step/step13.js) |
| 14 | TodoWrite session task tracking | [`step/step14.js`](../step/step14.js) |
| 15 | Persistent task graph | [`step/step15.js`](../step/step15.js) |
| 16 | MCP protocol support | [`step/step16.js`](../step/step16.js) |
| 17 | Skills system | [`step/step17.js`](../step/step17.js) |
| 18 | Sandbox | [`step/step18.js`](../step/step18.js) |
| 19 | Sub-agents and agent definitions | [`step/step19.js`](../step/step19.js) |
| 20 | Background agents and worktree isolation | [`step/step20.js`](../step/step20.js) |
| 21 | Agent Teams and multi-agent collaboration | [`step/step21.js`](../step/step21.js) |
| 22 | Hooks lifecycle system | [`step/step22.js`](../step/step22.js) |
| 23 | Output styles and user commands | [`step/step23.js`](../step/step23.js) |
| 24 | Rendering experience upgrades | [`step/step24.js`](../step/step24.js) |
| 25 | Configuration system improvements | [`step/step25.js`](../step/step25.js) |
| 26 | File history and rewind | [`step/step26.js`](../step/step26.js) |
| 27 | Error handling and resilience | [`step/step27.js`](../step/step27.js) |
| 28 | Headless and pipe mode | [`step/step28.js`](../step/step28.js) |
| 29 | Auto Mode classifier | [`step/step29.js`](../step/step29.js) |
| 30 | Multi-provider support | [`step/step30.js`](../step/step30.js) |
| 31 | Web, MultiEdit, MCP resources, and PowerShell | [`step/step31.js`](../step/step31.js) |
| 32 | Multimodal image and screenshot input | [`step/step32.js`](../step/step32.js) |
| 33 | Built-in command completion | [`step/step33.js`](../step/step33.js) |
| 34 | Extended Thinking controls and display | [`step/step34.js`](../step/step34.js) |
| 35 | Plugins and Marketplace | [`step/step35.js`](../step/step35.js) |
| 36 | Packaging, publishing, and documentation | [`step/step36.js`](../step/step36.js) |

After milestone 36 the product went through a hardening pass covering the Bash read-only analysis, path boundaries, configuration trust, the sandbox, local data permissions, atomic persistence, subprocess limits, Agent Teams concurrency, MCP recovery, tool input validation, hooks, configuration, user output, and the release gate. Those changes are in `src/` and the documents under [`docs/`](./); the snapshots were not updated for them.
