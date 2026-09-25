# Subprocess execution

Bash, PowerShell, command hooks and custom status-line commands use the same subprocess runner. It captures stdout and stderr in separate fixed-size byte rings. It keeps reading after a ring fills, so a chatty command does not stall on a full pipe, and returns the retained tail with a count of omitted bytes.

| Caller | Captured output per stream | Wall limit | Idle limit |
| --- | ---: | ---: | ---: |
| Bash | 30,000 bytes | 120 seconds by default; `timeout` overrides it | Same as wall limit by default; `idleTimeout` overrides it |
| PowerShell | 30,000 bytes | 120 seconds by default; `timeout` overrides it | Same as wall limit by default; `idleTimeout` overrides it |
| Command hook | 64 KiB | Hook `timeout`, default 60 seconds | Same as hook timeout |
| Custom status line | 8 KiB | 2 seconds | 2 seconds |

The wall timer measures total runtime. The idle timer resets whenever stdout or stderr produces data. A command can therefore hit either limit independently. Bash's live progress view retains at most 8,000 characters and continues to show the latest output and a heartbeat while the command runs.

On Unix, each command starts in its own process group. Timeout, idle timeout and cancellation send `SIGTERM` to the group, wait 500 milliseconds, then send `SIGKILL` if it has not closed. On Windows, Node.js has no Job Object API; the runner uses `taskkill /T /F` to terminate the process tree. The result is returned only after the child and its stdio streams close. Spawn failures and signal exits remain distinguishable from non-zero exit codes.

Hooks that exceed the output limit do not inject truncated text into the model context or parse incomplete JSON. An oversized `PreToolUse` result blocks the tool; other oversized hook results are reported as non-blocking errors. A status-line command with oversized output falls back to the built-in footer. Normal-size stdout, stderr and exit-code behavior is unchanged.

The current callers consume only bounded output, so they do not create full-output temporary files. A future caller that needs an entire long stream should spool it to a size-limited private file rather than increasing the in-memory ring.

Run `npm run test:controlled-process` to check large output, normal and signal exits, wall and idle timeouts, cancellation, descendant cleanup, Bash progress and hook output limits. The test also runs in `npm run verify:production`.
