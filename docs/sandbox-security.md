# Sandbox security

Easy Agent applies shell sandboxing through `@anthropic-ai/sandbox-runtime`. The runtime uses Seatbelt on macOS, bubblewrap on Linux, and a local proxy for domain-aware network policy.

## Configuration

Sandbox settings follow the normal trusted settings precedence. Project and local sandbox settings are ignored until the workspace is trusted.

```json
{
  "sandbox": {
    "enabled": true,
    "failClosed": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "filesystem": {
      "allowWrite": ["./generated"],
      "denyWrite": ["./generated/protected"],
      "denyRead": ["~/.ssh", "~/.aws"],
      "allowRead": []
    }
  }
}
```

`enabled` defaults to `false`. When enabled, `failClosed` defaults to `true`: an invalid configuration, missing dependency, unsupported platform, or runtime initialization failure blocks the command before it starts. Setting `failClosed` to `false` permits an unsandboxed fallback through the normal permission system and is reported in command output and `/doctor`.

Filesystem writes use an allow-only policy. The working directory and the Easy Agent temporary directory are writable, explicit `denyWrite` entries take precedence, and runtime configuration, extension definitions, `.env`, `.mcp.json`, and project instructions are protected from modification. Reads are allowed unless denied; `allowRead` can reopen an allowed area within a broader denied path, while a more specific deny remains blocked.

Public network access works without a domain allowlist. Shell commands use the sandbox proxy, which continues to block loopback, link-local, cloud metadata, and other protected addresses. Built-in WebSearch and WebFetch tools have their own permission path and are unaffected by Bash network settings.

Domain rules are optional. A non-empty `allowedDomains` list enables strict allowlist mode; `deniedDomains` is evaluated first. An empty allowlist keeps normal public network access available. Use `deniedDomains: ["*"]` to block all outbound destinations explicitly.

```json
{
  "sandbox": {
    "network": {
      "allowedDomains": ["registry.npmjs.org", "*.github.com"],
      "deniedDomains": ["gist.github.com"]
    }
  }
}
```

`dangerouslyDisableSandbox` works only when `allowUnsandboxedCommands` is true. `excludedCommands` can bypass isolation only for a single command; compound commands and command substitutions remain sandboxed.

Unknown sandbox keys and values with the wrong type are rejected. Easy Agent does not silently ignore a policy it cannot enforce.

## Platform support

| Platform | Backend | Requirements | Behavior |
| --- | --- | --- | --- |
| macOS | Seatbelt (`sandbox-exec`) | `sandbox-exec` and `rg` available | Filesystem, process tree, Unix socket, and proxy-based network restrictions |
| Linux / WSL2 | bubblewrap | `bubblewrap`, `socat`, `rg`, supported kernel namespaces | Filesystem, process tree, seccomp Unix-socket policy, and proxy-based network restrictions |
| Windows | Not integrated in Easy Agent | — | `/doctor` reports the limitation; enabled `failClosed` policy blocks PowerShell |

On Ubuntu or Debian, install Linux dependencies with:

```bash
sudo apt-get install bubblewrap socat ripgrep
```

Ubuntu 24.04 and newer may restrict unprivileged user namespaces through AppArmor. Easy Agent probes the user, PID, and network namespaces required by bubblewrap and reports a failed capability check in `/doctor`. Configure an AppArmor profile that grants `userns` to bubblewrap before enabling the sandbox. On a disposable CI runner, the restriction can be disabled for the job with:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Windows process isolation requires a separate provisioning and lifecycle design for the PowerShell tool. Until that integration is complete, Easy Agent does not report Windows shell commands as sandboxed.

## Migration

- Bash networking no longer requires an allowlist. Configuring a non-empty `network.allowedDomains` list opts into strict domain filtering.
- `filesystem.denyRead` and `filesystem.allowRead` now affect the child process.
- An enabled sandbox now blocks by default when unavailable. Use `failClosed: false` only as an explicit temporary compatibility setting.
- Remove unknown sandbox fields or correct their types before running shell commands.
- Linux installations must provide `bubblewrap`, `socat`, and `rg` before enabling the sandbox.

## Verification

Run portable policy tests and host integration tests separately:

```bash
npm run test:sandbox
npm run verify:production:platform
npm run verify:production
```

The platform suite runs real child processes and network requests. CI executes it on macOS and Ubuntu.
