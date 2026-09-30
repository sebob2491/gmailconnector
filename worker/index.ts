/**
 * Cloudflare Worker entry point: a hosted, multi-account Gmail connector for claude.ai.
 *
 * - /mcp is the MCP endpoint (Streamable HTTP, stateless), protected by OAuth.
 * - The OAuth provider (tokens, registration, discovery metadata) is @cloudflare/workers-oauth-provider.
 * - Everything a browser sees (setup page, consent, Google sign-in, account linking) is in routes.ts.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { TokenProvider } from "../src/gmailClient.js";
import { AuthError, defaultFetch } from "../src/google.js";
import { createServer } from "../src/server.js";
import { googleClient, KvAccountSource, type Env } from "./owner.js";
import { handleBrowserRequest } from "./routes.js";

// Access tokens are cached per isolate so consecutive tool calls don't each refresh with Google.
const tokenProviders = new Map<string, TokenProvider>();

function tokenProviderFor(env: Env, origin: string): TokenProvider {
  const client = googleClient(env);
  // Keyed by the client secret too, so rotating it takes effect without waiting for a new isolate.
  const key = `${origin}\n${client?.clientId ?? ""}\n${client?.clientSecret ?? ""}`;
  let provider = tokenProviders.get(key);
  if (!provider) {
    provider = new TokenProvider(
      async () => {
        if (!client) throw new AuthError(`Google isn't set up for this connector yet. Open ${origin}/ to finish setup.`);
        return client;
      },
      defaultFetch,
      `Re-link it at ${origin}/accounts`,
    );
    tokenProviders.set(key, provider);
  }
  return provider;
}

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
        { status: 405, headers: { Allow: "POST", "Content-Type": "application/json" } },
      );
    }
    const origin = new URL(request.url).origin;
    const server = createServer({
      store: new KvAccountSource(env.OAUTH_KV),
      tokens: tokenProviderFor(env, origin),
      manageHint: `To link or remove Gmail accounts, open ${origin}/accounts`,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const browserHandler = {
  fetch: (request: Request, env: Env) => handleBrowserRequest(request, env),
};

// The provider needs the Worker's public URL (the OAuth resource and issuer), which is only known
// from incoming requests, so one provider is built per origin.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: browserHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["gmail"],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["gmail"],
        resource_name: "Gmail (multiple accounts)",
      },
      // Keep Claude connected as long as it's used at least every 90 days.
      refreshTokenTTL: undefined,
      refreshTokenIdleTTL: 90 * 24 * 60 * 60,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
};
