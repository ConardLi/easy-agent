# Hooks

Configure command hooks in the `hooks` object of `~/.easy-agent/settings.json`, `<project>/.easy-agent/settings.json`, or `<project>/.easy-agent/settings.local.json`. Project and local hooks run only after the project is trusted. Settings from all active sources are combined in source order. Plugin hooks are added after file-based hooks.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          { "type": "command", "command": "./check-tool.sh", "timeout": 15 }
        ]
      }
    ]
  }
}
```

The supported events are `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, and `SubagentStop`. `PreToolUse` and `PostToolUse` match the tool name, `SessionStart` matches `startup`, `resume`, `clear`, or `compact`, and `SubagentStop` matches the agent type. Other events ignore `matcher`. An omitted matcher or `*` matches everything; a plain name matches exactly; an expression containing regex syntax is matched as a regular expression.

Only command hooks are executed. A hook receives a JSON event object on standard input, runs in the project directory, and receives `EASY_AGENT_PROJECT_DIR` in its environment. The default shell is `bash` on macOS and Linux and Windows PowerShell on Windows. Set `shell` to `sh`, `bash`, `powershell`, or `pwsh` to choose a different installed shell. Shell command syntax follows the selected shell; PowerShell scripts can read the event with `[Console]::In.ReadToEnd()`.

Command hooks default to a 60-second timeout. Exit code `0` succeeds, exit code `2` blocks, and other nonzero codes report a nonblocking error. A JSON object on stdout can set `decision`, `systemMessage`, `continue`, and `hookSpecificOutput`. Plain stdout from `UserPromptSubmit`, `SessionStart`, or `PostToolUse` becomes additional model context. Output is limited to 64 KiB per stream; truncated output is never interpreted as JSON or injected as context. `PreToolUse` blocks on oversized output, while other events report a nonblocking error. [Subprocess handling](./subprocesses.md) covers timeout, cancellation, and process cleanup.

Hook settings are checked again before each event. Valid edits take effect without restarting the CLI. If a settings file becomes unreadable or invalid, Easy Agent warns and keeps that file's last valid hooks until the error is fixed; removing the file or setting `"hooks": {}` clears its hooks. The `disableAllHooks` setting also updates live. `EASY_AGENT_DISABLE_HOOKS=1` disables hooks for the process.
