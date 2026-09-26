# MCP servers

Configure MCP servers under `mcpServers` in user or trusted project settings. Easy Agent supports stdio, Streamable HTTP, and legacy SSE servers. Run `/mcp` to see connection status and discovered tools, or `/mcp reconnect <name>` after changing a server configuration.

```json
{
  "mcpServers": {
    "local": { "command": "node", "args": ["/absolute/path/to/server.js"] },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headersEnv": { "Authorization": "MCP_AUTH_HEADER" }
    }
  }
}
```

`headersEnv` names an environment variable whose value becomes the complete header value, such as `Bearer <token>`. The variable is read for each request, but changing it in another shell does not change a running process's environment; restart Easy Agent after rotating it. `headers` remains available for static values. For rotation without restarting, `headersHelper` runs a configured executable for each request; it must print a JSON object of string headers and finish within five seconds. Helper output is not included in connection errors. Project settings and `.mcp.json` servers remain subject to project trust and approval.

For OAuth authorization code, set `"oauth": true` on an HTTP or SSE server. When authorization is required, Easy Agent prints a URL and shows it in `/mcp`; open it in a browser. The local callback receives the code, stores credentials in `~/.easy-agent/mcp/oauth/` with private file permissions, and reconnects the server. A dynamically registered client uses a stable loopback callback port derived from the server URL. If your provider requires a pre-registered client, configure its client ID and callback port:

```json
{
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "oauth": { "type": "authorization_code", "clientId": "your-client-id", "redirectPort": 43123 }
}
```

Register `http://127.0.0.1:43123/callback` with the provider. A client secret, if required, can be supplied through `clientSecretEnv`. For machine-to-machine OAuth, use `"oauth": { "type": "client_credentials", "clientId": "...", "clientSecretEnv": "MCP_CLIENT_SECRET" }`. Do not put the secret in settings. OAuth cannot be combined with custom Authorization headers or `headersHelper`.

MCP image results are forwarded as image content when supported by the model. Binary resources and other binary content are stored under `~/.easy-agent/mcp/artifacts/` with private permissions, and the tool result includes the file path. Structured content and unknown content blocks remain available in the tool result. Text-only results keep their previous string form.

When a connection closes, Easy Agent re-establishes it with exponential backoff and refreshes its tools. It retries a tool call only when an HTTP session-expired response confirms the server rejected the request. Other failed calls are reported without replay because the server may already have executed them. The client does not advertise Roots or elicitation support.

Run the offline MCP checks from the repository root:

```bash
npm run test:mcp
npm run test:mcp:hardening
```

These tests start local stdio, HTTP, SSE, and OAuth fixtures; they do not need a real provider account. For an installed server, start `npm run dev`, check `/mcp`, call one of its tools, then use `/mcp reconnect <name>` to confirm its configuration is reloaded.
