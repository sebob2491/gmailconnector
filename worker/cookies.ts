/**
 * Cookies, and sealing small values into them. State that exists before someone has signed in with
 * Google (the consent form's CSRF token, the Google sign-in in progress) lives in the browser, so an
 * anonymous visitor can't use up the Worker's daily KV write quota.
 */
import { base64url } from "../src/google.js";

/** `__Host-` cookies are only accepted over https, for this exact host, on path `/`. */
export function setCookie(name: string, value: string, maxAge: number): string {
  // Lax, not Strict: the cookie must come back on the top-level redirect from Google (and from
  // Claude's app opening the consent page), which a browser treats as a cross-site navigation.
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearCookie = (name: string): string => setCookie(name, "", 0);

function cookies(request: Request): [string, string][] {
  return (request.headers.get("Cookie") ?? "").split(";").flatMap((part) => {
    const [k, ...v] = part.trim().split("=");
    return k ? [[k, v.join("=")] as [string, string]] : [];
  });
}

export function readCookie(request: Request, name: string): string | undefined {
  return cookies(request).find(([k]) => k === name)?.[1];
}

export function cookieNamesWithPrefix(request: Request, prefix: string): string[] {
  return cookies(request)
    .map(([k]) => k)
    .filter((k) => k.startsWith(prefix));
}

function fromBase64url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();

/** An AES-GCM key derived from a Worker secret (so there's no extra secret to configure). */
function sealingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    const encode = (s: string) => new TextEncoder().encode(s);
    key = crypto.subtle
      .importKey("raw", encode(secret), "HKDF", false, ["deriveKey"])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encode("gmail-multi-mcp"), info: encode("browser cookie v1") },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    keys.set(secret, key);
  }
  return key;
}

/** Encrypts and authenticates `value` for `ttlSeconds`. Only this Worker can read or forge it. */
export async function seal(secret: string, value: object, ttlSeconds: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ ...value, exp: Date.now() + ttlSeconds * 1000 }));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealingKey(secret), plain);
  return `${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** The value sealed by seal(), or undefined if it was tampered with, sealed with another secret, or expired. */
export async function unseal<T>(secret: string, sealed: string | undefined): Promise<T | undefined> {
  const [iv, data] = (sealed ?? "").split(".");
  if (!iv || !data) return undefined;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await sealingKey(secret), fromBase64url(data));
    const value = JSON.parse(new TextDecoder().decode(plain)) as T & { exp: number };
    return typeof value.exp === "number" && value.exp > Date.now() ? value : undefined;
  } catch {
    return undefined;
  }
}
