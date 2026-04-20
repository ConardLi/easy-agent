# Easy Agent

An open-source, terminal-native project to fully recreate the Claude Code experience from the ground up.

Easy Agent is a long-horizon engineering project focused on rebuilding a complete local agentic coding system in TypeScript and Node.js. The goal is not to publish isolated demos, but to incrementally construct a production-style coding agent with a clean architecture, strong safety boundaries, multi-turn orchestration, local tool execution, and the extensibility required for a full Claude Code-class developer experience.

This repository is the open-source implementation track of that effort. Full documentation will be added over time. For now, this README focuses on the project itself: what it aims to become, how it is structured, and where implementation currently stands.

> Chinese version: see [README.zh-CN.md](./README.zh-CN.md)

## Vision

Easy Agent aims to become a serious open-source recreation of a modern local coding agent system.

Core goals:

- Fully recreate the Claude Code-style workflow in an open-source codebase
- Keep the architecture layered, explicit, and extensible
- Prioritize real engineering systems over toy examples
- Evolve incrementally toward a complete local Agent CLI
- Preserve a stable path toward persistence, compaction, MCP, skills, sandboxing, sub-agents, multi-agent collaboration, and multi-provider support

## Project Status

**Current stage:** foundational implementation in active development

The project already has meaningful groundwork across the CLI, streaming communication, tool execution, terminal UI, and session orchestration layers. At the same time, many advanced systems in the full recreation plan are still under active development.

Easy Agent should currently be understood as a serious open-source rebuild in progress rather than a finished end-user product.

## Architecture

Easy Agent is being built around a five-layer architecture:

```text
+---------------------------------------------------+
| 1. Interaction Layer                              |
|    Terminal UI, input handling, rendering         |
+---------------------------------------------------+
| 2. Orchestration Layer                            |
|    Multi-turn session flow, usage, commands       |
+---------------------------------------------------+
| 3. Core Agentic Loop                              |
|    Reason -> tool call -> observe -> continue     |
+---------------------------------------------------+
| 4. Tooling Layer                                  |
|    File, shell, search, and local actions         |
+---------------------------------------------------+
| 5. Model Communication Layer                      |
|    Streaming API communication with LLMs          |
+---------------------------------------------------+
```

This separation makes the system easier to evolve:

- the **communication layer** handles model I/O
- the **tool layer** exposes actionable capabilities
- the **agentic loop** drives single-turn autonomous execution
- the **orchestration layer** manages multi-turn state and control flow
- the **interaction layer** turns the runtime into a usable terminal product

## Repository Layout

```text
easy-agent/
├── src/
│   ├── entrypoint/      # CLI bootstrap
│   ├── ui/              # React/Ink terminal interface
│   ├── core/            # agentic loop and query orchestration
│   ├── tools/           # local tools and tool registry
│   ├── services/api/    # model client and streaming wrapper
│   ├── permissions/     # permission and safety controls
│   ├── context/         # system prompt and context management
│   ├── session/         # session persistence and history
│   ├── types/           # shared domain types
│   └── utils/           # env, config, logging, helpers
├── package.json
├── tsconfig.json
├── README.md
└── README.zh-CN.md
```

## Roadmap and Progress

The project follows a 30-phase roadmap designed to recreate the full Claude Code-style system progressively.

| Phase | Area | Core Code | Status |
|---|---|---|---:|
| 0 | Project scaffold | `planned in step series` | ✅ Done |
| 1 | LLM communication layer | [`step/step1.js`](./step/step1.js) | ✅ Done |
| 2 | React/Ink terminal UI | [`step/step2.js`](./step/step2.js) | ✅ Done |
| 3 | Tool interface and first tool | [`step/step3.js`](./step/step3.js) | ✅ Done |
| 4 | Core agentic loop | [`step/step4.js`](./step/step4.js) | ✅ Done |
| 5 | Complete core toolset | [`step/step5.js`](./step/step5.js) | ✅ Done |
| 6 | System prompt and context engineering | [`step/step6.js`](./step/step6.js) | ✅ Done |
| 7 | Permission control system | [`step/step7.js`](./step/step7.js) | ✅ Done |
| 8 | QueryEngine multi-turn orchestration | [`step/step8.js`](./step/step8.js) | ✅ Done |
| 9 | Session persistence and restore | [`step/step9.js`](./step/step9.js) | ✅ Done |
| 10 | Project memory system | [`step/step10.js`](./step/step10.js) | ✅ Done |
| 11 | Context compaction | [`step/step11.js`](./step/step11.js) | ✅ Done |
| 12 | Fine-grained token budget management | [`step/step12.js`](./step/step12.js) | ✅ Done |
| 13 | Plan mode | [`step/step13.js`](./step/step13.js) | ✅ Done |
| 14 | TodoWrite session task tracking | [`step/step14.js`](./step/step14.js) | ✅ Done |
| 15 | Task management system (V2) | [`step/step15.js`](./step/step15.js) | ✅ Done |
| 16 | MCP protocol support | [`step/step16.js`](./step/step16.js) | ✅ Done |
| 17 | Skills system | `planned` | ⏳ Not started |
| 18 | Sandbox | `planned` | ⏳ Not started |
| 19 | Sub-agents | `planned` | ⏳ Not started |
| 20 | Custom agent system | `planned` | ⏳ Not started |
| 21 | Multi-agent collaboration | `planned` | ⏳ Not started |
| 22 | Hooks lifecycle system | `planned` | ⏳ Not started |
| 23 | Terminal UI upgrades | `planned in step series` | 🚧 Partial |
| 24 | Configuration system improvements | `planned in step series` | 🚧 Partial |
| 25 | File history and rollback | `planned` | ⏳ Not started |
| 26 | Error handling and resilience | `planned in step series` | 🚧 Partial |
| 27 | Pipe mode / non-interactive execution | `planned` | ⏳ Not started |
| 28 | Auto mode | `planned in step series` | 🚧 Partial |
| 29 | Multi-provider support | `planned in step series` | ⏳ Not started |
| 30 | Packaging, publishing, and documentation | `planned in step series` | 🚧 Partial |

The [`easy-agent/step/`](./step/) directory contains tutorial-friendly milestone code, so each completed chapter is directly learnable and reproducible from a focused single file.

## What Easy Agent Is — and Is Not

**Easy Agent is:**
- an open-source recreation project
- a systems-engineering effort
- a long-term implementation of a local coding agent
- a public codebase evolving toward a full Claude Code-class CLI

**Easy Agent is not:**
- a one-file demo
- a prompt-only wrapper around an API
- a finished product today
- a public mirror of any private course material

## Getting Started

### Requirements

- Node.js
- npm
- Anthropic-compatible model access

### Environment Variables

Easy Agent currently supports the following environment variables:

- `ANTHROPIC_MODEL` — default model name
- `ANTHROPIC_BASE_URL` — custom API base URL
- `ANTHROPIC_AUTH_TOKEN` — API authentication token

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
npm start
```

### Example CLI Options

```bash
agent --help
agent --model claude-sonnet-4-20250514
agent --plan
agent --auto
agent --dump-system-prompt
```

## Near-Term Priorities

The next major milestones are:

1. a fuller plan-mode workflow
2. task management system
3. MCP, skills, and extensibility primitives
4. stronger configuration and safety boundaries
5. sub-agent and multi-agent collaboration
6. multi-provider architecture

## Contribution Policy

Easy Agent is **not accepting external contributions at this stage**.

The project is still in active reconstruction, and the implementation, structure, and development conventions are expected to change frequently. External contributions will be opened after the project reaches a more stable and maintainable state.

Until then, you are welcome to follow the project and reference the public roadmap, but pull requests and outside code contributions are intentionally postponed for now.

## License

MIT
