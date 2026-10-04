# Editors (Agent Client Protocol)

`eagent --acp` runs Easy Agent as an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent, so editors that speak ACP, such as Zed and JetBrains IDEs, can use it as an external agent. The editor starts the process and talks JSON-RPC over stdio; prompts, streamed replies, tool calls, diffs, and permission requests appear in the editor's agent panel.

Easy Agent implements ACP protocol version 1. It passes the [ACP Test Compatibility Kit](https://github.com/agentclientprotocol/acp-tck) v1 suite.

## Set up

Install Easy Agent and save a model API key once:

```bash
npm install -g eagent
eagent --login
```

`eagent --login` asks for an Anthropic (or Anthropic-compatible) API key, an optional base URL, and an optional model, and saves them in the `env` block of `~/.easy-agent/settings.json`, which only you can read. Keys already in the environment, such as `ANTHROPIC_AUTH_TOKEN`, work without it. OpenAI-compatible, Gemini, and local models are configured as model profiles; see [Configuration](./configuration.md).

### Zed

Add the agent to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Easy Agent": {
      "type": "custom",
      "command": "eagent",
      "args": ["--acp"]
    }
  }
}
```

Then open the agent panel and start a new Easy Agent thread.

### JetBrains IDEs

Add the agent to `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "Easy Agent": {
      "command": "eagent",
      "args": ["--acp"]
    }
  }
}
```

### Without a global install

Point the editor at `npx` instead: command `npx`, arguments `["-y", "eagent", "--acp"]`.

## Workspace trust

An editor cannot show Easy Agent's trust prompt, so ACP mode uses the trust decision saved for the workspace. A workspace you have never trusted runs with its project settings, `.env`, hooks, project MCP servers, and plugin executables ignored; user settings and permission rules still apply.

To trust a workspace, either open it once in the terminal with `eagent` and accept the prompt, or add `--trust-project-config` to the agent's arguments to trust whichever workspace the editor opens, for that process only.

## What maps to what

| Easy Agent | ACP |
| --- | --- |
| A session, saved under `~/.easy-agent/projects/` | A session. `session/new`, `session/load` (replays the conversation), `session/resume`, `session/list`, `session/close`, `session/delete` |
| A turn | `session/prompt`. Text, images, and embedded files are accepted; a link to a file is passed as a reference the model can read |
| Streamed text and thinking | `agent_message_chunk`, `agent_thought_chunk` |
| A tool call | `tool_call` and `tool_call_update` with a title, kind, the input, affected files, the output, and a diff for `Write`, `Edit`, and `MultiEdit` |
| A permission prompt | `session/request_permission` with Allow, Always allow this session, and Reject |
| Plan approval when leaving plan mode | `session/request_permission` of kind `switch_mode`, with the plan and the four approval choices |
| `AskUserQuestion` | A form `elicitation/create` when the editor supports forms; otherwise the question is cancelled and the model continues without an answer |
| Permission modes (default, plan, auto) | Session modes: `session/set_mode` and `current_mode_update` |
| The todo list or task list | `plan` |
| Context window usage | `usage_update` |
| Slash commands | `available_commands_update`. Commands that open a terminal view, such as `/resume` or `/diff`, are left out |
| Interrupt | `session/cancel`; the prompt ends with `cancelled` |
| MCP servers configured in the editor | Connected when a session opens, alongside the ones in Easy Agent's settings; a configured server with the same name wins |

Permission rules, the sandbox, and the Auto Mode classifier decide before a request reaches the editor; the editor cannot approve a call that settings deny. Easy Agent runs tools itself, in the session's directory, and does not use the editor's file system or terminal methods.

## Authentication

When no credentials are configured, `session/new` fails with ACP's `auth_required` error. If the editor supports terminal login, Easy Agent offers it in `authMethods`: the editor runs `eagent --login` in a terminal and reconnects afterwards.

## Limits

- One process serves one workspace. The editor's first session decides the directory; a session for another directory opens once every session of the first one is closed.
- Audio prompts are not supported.
- A background agent's result is delivered with the next prompt; it does not start a turn on its own.

## ACP Registry

`npm run acp:registry-entry` writes the registry entry for the current version to `.acp-registry/easy-agent/` (`agent.json` and `icon.svg`). After the version is published to npm, copy that folder into a fork of [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry) and open a pull request; later versions are picked up from npm automatically.
