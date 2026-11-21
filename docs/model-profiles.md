# Model profiles

All entry points use `models.<id>` as the connection contract. `model`, `modelRoles`, Harness `model.main` / `model.roles`, `--model`, SDK and ACP selections reference the stable profile ID. The upstream `model` is sent only inside that profile's connection. No match is a configuration error. One valid profile can be selected automatically; several require a default. With none, help, configuration editors and other non-model operations remain available.

```json
{
  "model": "main",
  "models": {
    "main": { "protocol": "openai-chat", "model": "gpt-4.1", "apiKey": "${EASY_AGENT_API_KEY}" },
    "claude": { "protocol": "anthropic", "model": "claude-sonnet-4-20250514", "apiKey": "${CLAUDE_KEY}" },
    "responses": { "protocol": "openai-responses", "model": "gpt-5.1", "apiKey": "${OPENAI_API_KEY}" },
    "gemini": { "protocol": "gemini", "model": "gemini-2.5-pro", "apiKey": "${GEMINI_API_KEY}" },
    "local": {
      "protocol": "openai-chat", "model": "qwen3-coder:30b", "baseURL": "http://localhost:11434/v1",
      "authentication": { "type": "none" }, "capabilities": { "contextWindow": 32768 }
    }
  },
  "reasoning": { "mode": "auto" }
}
```

Set each referenced variable before starting the runtime. Arbitrary variable names work because the profile explicitly declares them; Easy Agent does not automatically read provider variables.

| Field | Meaning |
|---|---|
| `protocol` | Required: `anthropic`, `openai-chat`, `openai-responses`, `gemini` |
| `model` | Required upstream model; custom gateway names work |
| `baseURL` | Optional HTTP(S) address; the explicit protocol supplies its official default. No embedded credentials, query or fragment |
| `apiKey` | One credential source: environment reference, desktop secure storage reference, or `{ "helper": "command" }` |
| `authentication` | `{ "type": "default" }`, `{ "type": "header", "name": "X-Gateway-Key", "prefix": "Key " }`, or explicit `{ "type": "none" }` |
| `headers` | Extra non-authentication headers, including declared environment references |
| `maxTokens` | Output limit, separately validated from context and reasoning budgets |
| `capabilities` | Explicit overrides: tools, vision, cache, reasoning, adaptiveReasoning, interleavedReasoning, effort, contextWindow, maxOutputTokens and optional pricing |
| `protocolOptions` | Options under the selected protocol only |

Anthropic uses `x-api-key`, OpenAI uses Bearer, Gemini uses `x-goog-api-key`. Custom authentication still uses the same `apiKey`. No-auth profiles must omit `apiKey`. Ordinary headers cannot add another authentication secret. Changing a saved profile's protocol or address requires its own explicit credential source or a no-auth policy, so lower-layer keys cannot leak to another destination.

```json
{
  "models": {
    "gateway": {
      "protocol": "anthropic",
      "model": "gateway-name",
      "baseURL": "https://gateway.example.com",
      "apiKey": { "helper": "vault read -field=key secret/agent" },
      "authentication": { "type": "header", "name": "Authorization", "prefix": "Bearer " },
      "headers": { "X-Team": "platform" },
      "capabilities": { "reasoning": true, "contextWindow": 64000 },
      "protocolOptions": { "anthropic": { "countTokens": false, "adaptiveThinking": false, "interleavedThinking": false } }
    }
  }
}
```

The helper belongs to this profile, has a 10-second timeout, and never writes a global provider credential. Failure of an explicitly selected source is reported; another profile's secret is never borrowed. Shared project files use credential references. The desktop stores pasted API Keys using its existing system secure storage.

`protocolOptions.anthropic` contains `countTokens`, `adaptiveThinking` and `interleavedThinking`. OpenAI protocol options contain `promptCacheKey`. Unknown compatible endpoints require an explicit opt-in for exact counting or cache keys; unsupported counting is shown as an estimate. Generation, connection tests, counting, search and request diagnostics resolve the same profile and authentication.

General reasoning uses `reasoning.mode: auto|on|off`, optional positive `budgetTokens`, and `effort: low|medium|high|max`. Unknown models send no unconfirmed automatic reasoning parameters. Explicit unsupported intent reports its limitation. Anthropic manual reasoning needs at least 1024 tokens and a budget below the output limit; output must fit the context window. Protocol adapters validate effort mappings. Plain `ultrathink` text does not change configuration.

Metadata follows explicit capability overrides, then known catalog facts. Unknown context windows use a labelled 32000-token estimate; prices remain unknown. Explicit `tools:false`, `vision:false` and `cache:false` restrict the corresponding requests. A model's known name does not add cloud authentication support.

`modelRoles` supports background, think, longContext, compaction and webFetch. Harness `model.roles.classifier` or `EASY_AGENT_AUTO_MODE_MODEL` selects the Auto Mode classifier. An unset role inherits the main profile; an invalid explicit role fails. Credentials are re-resolved on session restore and never saved in the transcript.

To select a saved profile use `EASY_AGENT_PROFILE=main`. For a temporary connection use `EASY_AGENT_PROTOCOL`, `EASY_AGENT_MODEL`, optional `EASY_AGENT_BASE_URL` and `EASY_AGENT_API_KEY`. Do not declare both connection targets in one layer. Higher-priority sources select a complete connection instead of mixing fields. Environment edits require a new runtime; supported settings updates apply to the next request.
