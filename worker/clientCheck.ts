/**
 * For the setup page: whether Google accepts the configured OAuth client (GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET). Google's token endpoint checks the client before the authorization code,
 * so exchanging a code that can't exist answers `invalid_grant` for a working client and
 * `invalid_client` (or `unauthorized_client`) for a wrong ID, secret or client type. Nothing is
 * created or stored at Google.
 *
 * Each check is one subrequest, so results are kept for 5 minutes per isolate and only the setup
 * page asks (rate-limited by the guard).
 */
import { defaultFetch, TOKEN_URL, type FetchLike, type OAuthClientConfig } from "../src/google.js";

export type ClientCheck =
  | { state: "ok" }
  /** Google refused the client; `problem` says what to fix. */
  | { state: "bad"; code: string; problem: string }
  | { state: "unknown"; reason: string };

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 3000;
const cache = new Map<string, { at: number; result: Promise<ClientCheck> }>();

/** What a refusal from Google means for the person setting up the connector. */
function explain(code: string, description: string): string {
  if (code === "invalid_client") {
    if (/not found/i.test(description)) {
      return "Google doesn't know this Client ID. Check GOOGLE_CLIENT_ID: copy the Client ID again (it ends in .apps.googleusercontent.com), with no spaces.";
    }
    if (/unauthorized/i.test(description)) {
      return "Google knows the Client ID, but the Client secret doesn't match it. Check GOOGLE_CLIENT_SECRET (you can add a new secret to the client in Google Cloud).";
    }
    return "The Client ID or Client secret is wrong. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.";
  }
  if (code === "unauthorized_client") {
    return "This client can't be used here. Create a client of type Web application (not Desktop, Android or iOS) and use its ID and secret.";
  }
  if (code === "redirect_uri_mismatch") {
    return "The client doesn't list this connector's redirect URI. Add it under Authorized redirect URIs (step 6).";
  }
  return `Google refused the client (${code}).`;
}

async function check(client: OAuthClientConfig, redirectUri: string, fetchImpl: FetchLike): Promise<ClientCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        // Never a real code: Google answers invalid_grant once the client checks out.
        code: "connector-setup-check",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; error_description?: unknown };
    const code = typeof body.error === "string" ? body.error : "";
    if (code === "invalid_grant") return { state: "ok" };
    if (code === "invalid_client" || code === "unauthorized_client" || code === "redirect_uri_mismatch") {
      return { state: "bad", code, problem: explain(code, typeof body.error_description === "string" ? body.error_description : "") };
    }
    return { state: "unknown", reason: `Google answered unexpectedly (HTTP ${res.status}${code ? `, ${code.slice(0, 40)}` : ""}).` };
  } catch {
    return { state: "unknown", reason: controller.signal.aborted ? "Google didn't answer in time." : "Couldn't reach Google." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The check for `client`, from the cache when it ran in the last 5 minutes. `allow` is asked only
 * when Google would be called; when it says no, the answer is "unknown".
 */
export async function checkGoogleClient(
  client: OAuthClientConfig,
  redirectUri: string,
  allow: () => boolean,
  fetchImpl: FetchLike = defaultFetch,
  now = Date.now(),
): Promise<ClientCheck> {
  const key = `${client.clientId}\n${client.clientSecret}\n${redirectUri}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  if (!allow()) return { state: "unknown", reason: "Checked too often just now; reload this page in a minute." };
  // Only the newest settings matter; older entries would only hold old secrets in memory.
  cache.clear();
  const result = check(client, redirectUri, fetchImpl);
  cache.set(key, { at: now, result });
  return result;
}
