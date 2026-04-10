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
┌─────────────────────────────────────────────┐
│ 1. Interaction Layer                        │
│    Terminal UI, input handling, rendering   │
├─────────────────────────────────────────────┤
│ 2. Orchestration Layer                      │
│    Multi-turn session flow, usage, commands │
├─────────────────────────────────────────────┤
│ 3. Core Agentic Loop                        │
│    Reason → tool call → observe → continue  │
├─────────────────────────────────────────────┤
│ 4. Tooling Layer                            │
│    File, shell, search, and local actions   │
├─────────────────────────────────────────────┤
│ 5. Model Communication Layer                │
│    Streaming API communication with LLMs    │
└─────────────────────────────────────────────┘
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

| Phase | Area | Status |
|---|---|---:|
| 0 | Project scaffold | ✅ Done |
| 1 | LLM communication layer | ✅ Done |
| 2 | React/Ink terminal UI | ✅ Done |
| 3 | Tool interface and first tool | ✅ Done |
| 4 | Core agentic loop | ✅ Done |
| 5 | Complete core toolset | ✅ Done |
| 6 | System prompt and context engineering | 🚧 Partial |
| 7 | Permission control system | 🚧 Partial |
| 8 | QueryEngine multi-turn orchestration | 🚧 Partial |
| 9 | Session persistence and restore | ⏳ Not started |
| 10 | Project memory system | ⏳ Not started |
| 11 | Context compaction | ⏳ Not started |
| 12 | Fine-grained token budget management | ⏳ Not started |
| 13 | Plan mode | 🚧 Partial |
| 14 | Task management system | ⏳ Not started |
| 15 | MCP protocol support | ⏳ Not started |
| 16 | Skills system | ⏳ Not started |
| 17 | Sandbox | ⏳ Not started |
| 18 | Sub-agents | ⏳ Not started |
| 19 | Custom agent system | ⏳ Not started |
| 20 | Multi-agent collaboration | ⏳ Not started |
| 21 | Hooks lifecycle system | ⏳ Not started |
| 22 | Terminal UI upgrades | 🚧 Partial |
| 23 | Configuration system improvements | 🚧 Partial |
| 24 | File history and rollback | ⏳ Not started |
| 25 | Error handling and resilience | 🚧 Partial |
| 26 | Pipe mode / non-interactive execution | ⏳ Not started |
| 27 | Auto mode | 🚧 Partial |
| 28 | Multi-provider support | ⏳ Not started |
| 29 | Packaging, publishing, and documentation | 🚧 Partial |

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

1. session persistence and restore
2. project memory and context compaction
3. a fuller plan-mode workflow
4. stronger configuration and safety boundaries
5. MCP, skills, and extensibility primitives
6. multi-provider architecture

## Contribution Policy

Easy Agent is **not accepting external contributions at this stage**.

The project is still in active reconstruction, and the implementation, structure, and development conventions are expected to change frequently. External contributions will be opened after the project reaches a more stable and maintainable state.

Until then, you are welcome to follow the project and reference the public roadmap, but pull requests and outside code contributions are intentionally postponed for now.

## License

MIT
