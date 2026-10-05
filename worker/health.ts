/**
 * Checks, for the accounts page, whether each linked account's Google access still works, by
 * refreshing its token. Nothing is stored: the access token Google returns is thrown away.
 */
import type { LinkedAccount } from "../src/accounts.js";
import { AuthError, defaultFetch, refreshAccessToken, type FetchLike, type OAuthClientConfig } from "../src/google.js";

export type AccountHealth =
  | { state: "working" }
  /** Google answered invalid_grant: the password changed, access was revoked, or the token expired. */
  | { state: "relink" }
  /** Google couldn't be reached or answered with an error that says nothing about this account. */
  | { state: "unknown"; reason: string };

/**
 * Each check is one call to Google's token endpoint, so this many checks keep a page view well
 * inside the free plan's 50 subrequests. Nobody links this many Gmail accounts; it only bounds the cost.
 */
export const MAX_HEALTH_CHECKS = 20;
const CHECK_TIMEOUT_MS = 3000;

async function checkOne(client: OAuthClientConfig, refreshToken: string, fetchImpl: FetchLike): Promise<AccountHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let status: number | undefined;
  const timedFetch: FetchLike = async (input, init) => {
    const res = await fetchImpl(input, { ...init, signal: controller.signal });
    status = res.status;
    return res;
  };
  try {
    await refreshAccessToken(client, refreshToken, timedFetch);
    return { state: "working" };
  } catch (error) {
    if (error instanceof AuthError && error.code === "invalid_grant") return { state: "relink" };
    if (controller.signal.aborted) return { state: "unknown", reason: "Google didn't answer in time." };
    // A rejected OAuth client is a setup problem the message explains (check GOOGLE_CLIENT_ID …).
    if (error instanceof AuthError && (error.code === "invalid_client" || error.code === "unauthorized_client")) {
      return { state: "unknown", reason: `${error.message}.` };
    }
    if (status !== undefined) return { state: "unknown", reason: `Google answered with an error (HTTP ${status}).` };
    return { state: "unknown", reason: "Couldn't reach Google." };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks every account in parallel (at most MAX_HEALTH_CHECKS of them). Never throws. */
export async function checkAccounts(
  client: OAuthClientConfig | undefined,
  accounts: LinkedAccount[],
  fetchImpl: FetchLike = defaultFetch,
): Promise<AccountHealth[]> {
  return Promise.all(
    accounts.map(async (account, i): Promise<AccountHealth> => {
      if (!client) return { state: "unknown", reason: "Google isn't set up for this connector yet." };
      if (i >= MAX_HEALTH_CHECKS) return { state: "unknown", reason: "Too many accounts to check at once." };
      try {
        return await checkOne(client, account.refreshToken, fetchImpl);
      } catch {
        return { state: "unknown", reason: "Couldn't reach Google." };
      }
    }),
  );
}
