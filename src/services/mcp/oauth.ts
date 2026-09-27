import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { AddressInfo } from "node:net";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthConfig } from "../../types/mcp.js";
import { getEasyAgentPath } from "../../utils/paths.js";
import { writePrivateFile } from "../../utils/privateData.js";
import { CLIENT_NAME } from "../../version.js";

interface SavedAuth {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

class AuthorizationCodeProvider implements OAuthClientProvider {
  private readonly stateValue = randomBytes(24).toString("hex");
  private authorizationUrl?: string;
  private resolveCode?: (code: string) => void;
  private readonly codePromise = new Promise<string>((resolve) => {
    this.resolveCode = resolve;
  });
  private constructor(
    private readonly config: Extract<McpOAuthConfig, { type: "authorization_code" }>,
    private readonly filePath: string,
    private readonly saved: SavedAuth,
    private readonly listener: Server,
    readonly redirectUrl: string,
  ) {}

  static async create(name: string, serverUrl: string, config: Extract<McpOAuthConfig, { type: "authorization_code" }>): Promise<AuthorizationCodeProvider> {
    const key = createHash("sha256").update(`${name}\0${serverUrl}\0${config.clientId ?? ""}\0${config.scope ?? ""}`).digest("hex");
    const filePath = getEasyAgentPath("mcp", "oauth", `${key}.json`);
    let saved: SavedAuth = {};
    try {
      const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!(await file.stat()).isFile()) throw new Error("MCP OAuth credential path is not a regular file");
        saved = JSON.parse(await file.readFile("utf8")) as SavedAuth;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const listener = createServer();
    const defaultPort = 39_000 + (parseInt(key.slice(0, 8), 16) % 20_000);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(config.redirectPort ?? defaultPort, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const port = (listener.address() as AddressInfo).port;
    listener.unref();
    const provider = new AuthorizationCodeProvider(config, filePath, saved, listener, `http://127.0.0.1:${port}/callback`);
    listener.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", provider.redirectUrl);
      if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (state !== provider.stateValue || !code) {
        response.writeHead(400).end("Authorization failed");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Authorization received. You can return to Easy Agent.");
      provider.resolveCode?.(code);
      provider.resolveCode = undefined;
    });
    return provider;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }
  state(): string { return this.stateValue; }
  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) {
      const secret = this.config.clientSecretEnv ? process.env[this.config.clientSecretEnv] : undefined;
      if (this.config.clientSecretEnv && !secret) throw new Error(`MCP OAuth requires environment variable ${this.config.clientSecretEnv}`);
      return { client_id: this.config.clientId, ...(secret ? { client_secret: secret } : {}) };
    }
    return this.saved.client;
  }
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> { this.saved.client = info; await this.persist(); }
  tokens(): OAuthTokens | undefined { return this.saved.tokens; }
  async saveTokens(tokens: OAuthTokens): Promise<void> { this.saved.tokens = tokens; delete this.saved.verifier; await this.persist(); }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url.toString(); }
  async saveCodeVerifier(verifier: string): Promise<void> { this.saved.verifier = verifier; await this.persist(); }
  codeVerifier(): string { if (!this.saved.verifier) throw new Error("Missing MCP OAuth code verifier"); return this.saved.verifier; }
  get pendingAuthorizationUrl(): string | undefined { return this.authorizationUrl; }
  waitForCode(): Promise<string> { return this.codePromise; }
  close(): void { this.listener.close(); }
  private async persist(): Promise<void> { await writePrivateFile(this.filePath, JSON.stringify(this.saved)); }
}

export interface McpAuthSession {
  provider: OAuthClientProvider;
  interactive?: AuthorizationCodeProvider;
  close: () => void;
}

export async function createMcpAuthSession(name: string, serverUrl: string, config: McpOAuthConfig | undefined): Promise<McpAuthSession | undefined> {
  if (!config) return undefined;
  if (config.type === "client_credentials") {
    const secret = process.env[config.clientSecretEnv];
    if (!secret) throw new Error(`MCP OAuth requires environment variable ${config.clientSecretEnv}`);
    return {
      provider: new ClientCredentialsProvider({ clientId: config.clientId, clientSecret: secret, clientName: CLIENT_NAME, scope: config.scope }),
      close: () => {},
    };
  }
  const provider = await AuthorizationCodeProvider.create(name, serverUrl, config);
  return { provider, interactive: provider, close: () => provider.close() };
}
