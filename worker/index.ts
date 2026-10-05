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
import { connectionAllowed, googleClient, KvAccountSource, type Env, type GrantProps } from "./owner.js";
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

/**
 * How many MB of attachments forward and update_draft re-attach. Re-attaching costs roughly 3 ms of
 * CPU per MB, and Cloudflare's free plan allows 10 ms per request, so the default is 2 MB; on the
 * paid plan MAX_FORWARD_MB can go up to Gmail's 25 MB.
 */
const DEFAULT_MAX_FORWARD_MB = 2;

function forwardLimit(env: Env): { maxAttachmentBytes: number; maxAttachmentNote: string } {
  const configured = Number((env as Env & { MAX_FORWARD_MB?: string }).MAX_FORWARD_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 25) : DEFAULT_MAX_FORWARD_MB;
  return {
    maxAttachmentBytes: Math.floor(mb * 1048576),
    maxAttachmentNote:
      "The connector's owner can raise this limit with the MAX_FORWARD_MB variable in the Cloudflare Worker's settings " +
      "(above about 2 MB that needs Cloudflare's paid Workers plan, because of the free plan's CPU limit).",
  };
}

const jsonRpcError = (message: string, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });

/**
 * Ends a Claude connection whose approving address may no longer use the connector (taken off
 * ALLOWED_EMAILS, or no longer the owner). Revoking the grant makes Claude's next token refresh fail
 * too, so Claude asks the user to connect again instead of retrying the same token.
 */
async function endConnection(request: Request, env: Env, origin: string, email: string): Promise<Response> {
  const [userId, grantId] = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").split(":");
  try {
    if (userId && grantId) await env.OAUTH_PROVIDER.revokeGrant(grantId, userId);
  } catch (error) {
    // Still refuse the request; the next one tries again.
    console.warn("Could not revoke a connection that is no longer allowed:", error);
  }
  const message =
    `This connection was made by ${email}, which may no longer use this Gmail connector, so it has been ended. ` +
    `Reconnect the connector in Claude and sign in with an allowed Google account.`;
  // A header value must be printable ASCII, and the quoted string can't hold quotes or backslashes.
  const quoted = message.replace(/[^\x20-\x7e]|["\\]/g, "");
  return jsonRpcError(message, 401, {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${quoted}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  });
}

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: GrantProps }): Promise<Response> {
    if (request.method !== "POST") return jsonRpcError("Method not allowed.", 405, { Allow: "POST" });
    const origin = new URL(request.url).origin;
    // Connections made before the approving address was recorded carry no email; they were made by
    // the owner and keep working.
    const email = ctx.props?.email;
    if (!(await connectionAllowed(env, email))) return endConnection(request, env, origin, email!);
    const server = createServer({
      store: new KvAccountSource(env.OAUTH_KV),
      tokens: tokenProviderFor(env, origin),
      manageHint: `To link or remove Gmail accounts, open ${origin}/accounts`,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      ...forwardLimit(env),
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
