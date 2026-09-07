# Configuration trust and credentials

Easy Agent resolves workspace trust before it applies project-controlled environment variables or settings that can change execution, provider routing, or resource access. The trust decision is stored outside the repository in `~/.easy-agent/state.json`, so a project cannot mark itself as trusted.

Interactive sessions ask before continuing in a new workspace. Headless commands do not prompt. An untrusted headless command uses user, command-line, and managed-policy configuration while ignoring trust-sensitive values from `.easy-agent/settings.json`, `.easy-agent/settings.local.json`, and `.env`.

After reviewing a project, allow its configuration for one command without changing persistent trust state:

```bash
eagent --trust-project-config -p "summarize this repository"
```

Previously trusted workspaces continue to use their project configuration in headless mode without this flag.

## Source precedence

Settings use the following order, from lowest to highest priority:

1. `~/.easy-agent/settings.json`
2. `<project>/.easy-agent/settings.json`, when trusted
3. `<project>/.easy-agent/settings.local.json`, when trusted
4. command-line settings and `--settings`
5. managed policy

For process environment values, `<project>/.env` is applied after project and local settings and before command-line settings and managed policy. The parent process supplies the initial environment.

Project, local, and `.env` sources cannot replace a credential-shaped environment variable that was already supplied by the parent process. This protection covers API keys, auth and access tokens, secrets, passwords, credentials, private keys, and client secrets. User settings, explicit command-line settings, and managed policy remain trusted sources and can override the inherited environment according to precedence.

Project and local `mode` and `autoMode` values never change the permission mode, including in a trusted workspace. Restrictive project values such as deny rules, hook disabling, MCP server disabling, and `claudeMdExcludes` remain effective while untrusted because they only remove capability.

## Trust-sensitive settings

The following project and local settings are ignored until the workspace is trusted:

- `env` and project `.env`
- model profiles, provider endpoints, credentials, headers, and environment interpolation
- MCP server definitions and project MCP approvals
- plugin enablement
- sandbox configuration
- `apiKeyHelper` and `statusLine` commands
- hooks and permission allow rules
- `additionalDirectories`
- runtime options such as model selection, output style, retention, and feature settings

Trusting a project allows its model profiles to interpolate environment variables and route requests to the configured provider. Review custom `baseURL`, `apiKey`, and `headers` values before trusting a repository.

## Diagnostics and redaction

Use `/config list`, `/model list`, and `/doctor` to inspect effective sources. Credential values, header values, environment values, URL credentials, query strings, and fragments are redacted. Provider URLs are displayed as an origin with the remaining path hidden. `/doctor` reports environment source counts without printing variable names or values.

## Migration

Existing interactive workflows require no change after the workspace has been trusted. For a new workspace, accept the trust prompt after reviewing its configuration.

Headless and CI workflows that previously relied on project settings or `.env` must choose one of these options:

- move credentials and provider configuration to the parent environment or user settings;
- establish persistent trust interactively on the same machine; or
- pass `--trust-project-config` for each reviewed invocation.

Keep credentials outside project files. If a trusted project profile uses `${VARIABLE}` interpolation, supply that variable from the parent process or user configuration. Project environment values no longer replace an inherited credential with the same name.

## Verification

Run the focused trust-boundary suite and the complete offline production gate:

```bash
npm run test:config-trust
npm run verify:production
```

The focused suite checks untrusted and trusted environment loading, inherited credential protection, provider routing, MCP, plugins, sandbox settings, permissions, configuration redaction, and the headless opt-in flag.
